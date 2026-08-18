import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { config } from "./config.js";
import { generateSlackImagePreview } from "./image-preview.js";
import { createImageGenerationProvider } from "./images/create-provider.js";
import { createDraftModelProvider } from "./llm/create-provider.js";
import type { PendingWebflowDraft } from "./pending-draft.js";
import { formatProposalPreview } from "./proposal-preview.js";
import { SlackflowRunStore } from "./run-store.js";
import { parseSlackflowCommand, type SlackflowCommand } from "./slack-command.js";
import { fetchEntireThread } from "./slack-thread-collector.js";
import { buildThreadTranscript } from "./thread.js";
import { webflowSiteDesignerUrl } from "./webflow-links.js";
import { WebflowMcpConnection, type WebflowCreatedItem } from "./webflow-mcp.js";
import { renderWebflowOAuthPage } from "./webflow-oauth-page.js";
import { truncationNote, webflowCollectionsFromData, webflowSitesFromData } from "./webflow-selection.js";
import { applyWebflowImagesToDraft, assertSchemaMatchesContract, categoryReferenceCollectionId, createWebflowDraftContract, createWebflowDraftMapping, verifiedCategoryItemIds, type WebflowDraftContract } from "./webflow-draft.js";

const receiver = new SocketModeReceiver({ appToken: config.slack.appToken, logLevel: LogLevel.INFO });
const app = new App({
  logLevel: LogLevel.INFO,
  receiver,
  token: config.slack.botToken
});

/**
 * Socket Mode emits `disconnected` during its own routine reconnects, so a
 * monitor is only told the bot is down once the gap outlasts that.
 */
const SLACK_RECONNECT_GRACE_MS = 90 * 1000;
let slackSocketState: "starting" | "connected" | "disconnected" = "starting";
let slackDisconnectedSince: number | undefined;
receiver.client.on("connected", () => {
  slackSocketState = "connected";
  slackDisconnectedSince = undefined;
});
receiver.client.on("reconnecting", () => { slackSocketState = "starting"; });
receiver.client.on("disconnected", () => {
  slackSocketState = "disconnected";
  slackDisconnectedSince ??= Date.now();
});

const draftModelProvider = createDraftModelProvider(config.llm);
const imageGenerationProvider = createImageGenerationProvider(config.image);
const runStore = new SlackflowRunStore(config.statePath);
const webflowConnection = new WebflowMcpConnection({
  mcpUrl: config.webflow.mcpUrl,
  publicBaseUrl: config.webflow.publicBaseUrl ?? "",
  statePath: config.statePath,
  tokenEncryptionKey: config.webflow.tokenEncryptionKey ?? ""
});
const healthServer = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

let cachedBotIdentity: { botId?: string; userId: string } | undefined;
const startedAt = Date.now();
/** A reviewed draft survives a restart, so the review window is generous. */
const PENDING_WEBFLOW_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** In-process only: a restart cannot leave a create or regenerate stuck as in flight. */
const draftsInFlight = new Set<string>();
/** Site short names, so a created draft can link back to its Webflow site. */
const siteShortNames = new Map<string, string>();

function storePendingWebflowDraft(input: Omit<PendingWebflowDraft, "expiresAt">): string {
  const draftId = randomUUID();
  webflowConnection.savePendingDraft(draftId, { ...input, expiresAt: Date.now() + PENDING_WEBFLOW_DRAFT_TTL_MS });
  return draftId;
}

async function siteShortName(siteId: string): Promise<string | undefined> {
  if (siteShortNames.has(siteId)) return siteShortNames.get(siteId);
  for (const site of webflowSitesFromData((await webflowConnection.listSites()).data).choices) {
    if (site.shortName) siteShortNames.set(site.id, site.shortName);
  }
  return siteShortNames.get(siteId);
}

/** A button click is only honoured in the thread the review was posted in. */
function loadPendingDraft(draftId: string, context: { channel: string; threadTs?: string }): PendingWebflowDraft | "wrong_thread" | undefined {
  const pending = webflowConnection.getPendingDraft(draftId);
  if (!pending) return undefined;
  if (pending.channel !== context.channel || pending.rootTs !== context.threadTs) return "wrong_thread";
  return pending;
}

function commandReply(command: Exclude<SlackflowCommand, "connect" | "disconnect" | "draft" | "status" | null>): string {
  switch (command) {
    case "help":
      return [
        "*Slackflow commands*",
        "• `@slackflow draft` prepares a strict-transfer draft, Markdown file, thumbnail, and banner in this thread.",
        "• `@slackflow status` shows the current Slackflow and Webflow state.",
        "• `@slackflow connect` posts a one-time Webflow OAuth link in this thread.",
        "• `@slackflow schema` reads a selected Webflow CMS schema only.",
        "• `@slackflow disconnect` removes Slackflow's encrypted local Webflow connection.",
        "After a matching CMS schema is captured, `@slackflow draft` offers an explicit Create Webflow draft button. It creates an unpublished item only."
      ].join("\n");
    case "schema":
      return ":information_source: Run `@slackflow schema` to choose a website and read its CMS fields. This step is read-only.";
  }
}

function webflowStatusReply(): string {
  const status = webflowConnection.status();
  const lines = [
    "*Slackflow status*",
    `• Slack Socket Mode: ${slackSocketState}`,
    "• Draft generation: available",
    "• Image preview: available for ready drafts"
  ];

  if (status.state === "configuration_missing") {
    lines.push(`• Webflow MCP: configuration missing (${status.message})`);
  } else if (status.state === "not_connected") {
    lines.push("• Webflow MCP OAuth: not connected");
  } else {
    lines.push(`• Webflow MCP OAuth: connected locally at ${new Date(status.connectedAt).toISOString()}`);
    if (status.serverName) lines.push(`• Webflow MCP server: ${status.serverName}${status.serverVersion ? ` ${status.serverVersion}` : ""}`);
  }

  const schema = webflowConnection.schemaStatus();
  lines.push(schema.state === "read"
    ? `• Webflow CMS schema: read for ${schema.collectionName ?? "collection"} (\`${schema.collectionId}\`) at ${new Date(schema.readAt).toISOString()}`
    : "• Webflow CMS schema: not read");
  lines.push(schema.state === "read"
    ? "• Webflow drafts: available after Slackflow validates each reviewed proposal and you confirm it"
    : "• Webflow drafts: unavailable until a CMS schema is selected and captured");
  lines.push("• Webflow publishing: disabled");
  return lines.join("\n");
}

function fieldLabelsFromWebflowData(value: unknown): string[] {
  const fields = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const record = item as Record<string, unknown>;
    const label = [record.displayName, record.name, record.slug]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (label && typeof record.type === "string") fields.add(label.trim());
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...fields].slice(0, 20);
}

function schemaSelectionBlocks<T extends { id: string; label: string }>(heading: string, prompt: string, actionId: string, choices: T[], valueFor: (choice: T) => string) {
  return [
    { type: "header" as const, text: { type: "plain_text" as const, text: heading, emoji: true } },
    { type: "section" as const, text: { type: "mrkdwn" as const, text: prompt } },
    {
      type: "actions" as const,
      elements: [{
        type: "static_select" as const,
        action_id: actionId,
        placeholder: { type: "plain_text" as const, text: heading.slice(0, 150), emoji: true },
        options: choices.map((choice) => ({
          text: { type: "plain_text" as const, text: choice.label.slice(0, 75), emoji: true },
          value: valueFor(choice)
        }))
      }]
    }
  ];
}

function actionContext(body: unknown): { channel: string; threadTs?: string; user: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = body as { channel?: { id?: unknown }; container?: { thread_ts?: unknown }; user?: { id?: unknown } };
  if (typeof value.channel?.id !== "string" || typeof value.user?.id !== "string") return undefined;
  return { channel: value.channel.id, threadTs: typeof value.container?.thread_ts === "string" ? value.container.thread_ts : undefined, user: value.user.id };
}

function actionMessageTs(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = body as { container?: { message_ts?: unknown } };
  return typeof value.container?.message_ts === "string" ? value.container.message_ts : undefined;
}

function actionValue(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const value = action as { selected_option?: { value?: unknown }; value?: unknown };
  if (typeof value.value === "string") return value.value;
  return typeof value.selected_option?.value === "string" ? value.selected_option.value : undefined;
}

function parseCollectionSelection(value: string): { collectionId: string; siteId: string } | undefined {
  const [siteId, collectionId, ...rest] = value.split(":");
  if (!siteId || !collectionId || rest.length > 0) return undefined;
  return { collectionId, siteId };
}

function actionSelectedLabel(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const value = action as { selected_option?: { text?: { text?: unknown } } };
  return typeof value.selected_option?.text?.text === "string" ? value.selected_option.text.text : undefined;
}

function safeWebflowReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Webflow MCP error.";
  const safeMessage = message
    .replace(/(access[_-]?token|refresh[_-]?token|authorization|bearer)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/g, "[URL redacted]")
    .slice(0, 350);

  if (/create_collection_items/i.test(safeMessage) && /expected.*array/i.test(safeMessage)) {
    return "Webflow rejected the CMS draft payload. Nothing was created. Ask whoever maintains Slackflow to check the service logs.";
  }

  if (/path.*actions|expected.*array|received.*undefined/i.test(safeMessage)) {
    return "Webflow rejected the request. Nothing was changed. Ask whoever maintains Slackflow to check the service logs.";
  }

  return safeMessage;
}

function webflowConnectBlocks(link: string) {
  return [
    {
      text: { emoji: true, text: "Connect Slackflow to Webflow", type: "plain_text" as const },
      type: "header" as const
    },
    {
      text: {
        text: "This one-time link expires in 10 minutes. Complete Webflow OAuth in your browser. Slackflow stores the resulting token encrypted in its local SQLite state. It will not read a CMS schema or make any Webflow change yet.",
        type: "mrkdwn" as const
      },
      type: "section" as const
    },
    {
      elements: [{ text: { emoji: true, text: "Connect Webflow", type: "plain_text" as const }, type: "button" as const, url: link }],
      type: "actions" as const
    }
  ];
}

function webflowConnectedBlocks() {
  return [
    {
      text: { emoji: true, text: "Webflow connected", type: "plain_text" as const },
      type: "header" as const
    },
    {
      text: {
        text: ":white_check_mark: Slackflow saved the encrypted OAuth connection. Run `@slackflow schema` in this thread to choose the target website and CMS collection. This next step is read-only.",
        type: "mrkdwn" as const
      },
      type: "section" as const
    }
  ];
}

function webflowDraftApprovalBlocks(input: { draftId: string }): KnownBlock[] {
  return [
    { type: "header", text: { type: "plain_text", text: "Create Webflow draft?", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: "Review the attached Markdown, Thumbnail Image, and Banner Image. This creates one *unpublished* CMS draft and never publishes it." } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "slackflow_create_webflow_draft",
          style: "primary",
          text: { type: "plain_text", text: "Create Webflow draft", emoji: true },
          value: input.draftId,
          confirm: {
            title: { type: "plain_text", text: "Create unpublished Webflow draft?", emoji: true },
            text: { type: "mrkdwn", text: "Slackflow will upload the reviewed thumbnail and banner, then create one CMS item as a draft. It will not publish it." },
            confirm: { type: "plain_text", text: "Create draft", emoji: true },
            deny: { type: "plain_text", text: "Cancel", emoji: true }
          }
        },
        {
          type: "button",
          action_id: "slackflow_regenerate_webflow_image",
          text: { type: "plain_text", text: "Regenerate image", emoji: true },
          value: input.draftId
        }
      ]
    }
  ];
}

function webflowDraftCreatedBlocks(input: { collectionName?: string; editorUrl?: string; itemId: string; title: string }): KnownBlock[] {
  const collection = input.collectionName ?? "selected";
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Webflow draft created", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *${input.title}* was created as an unpublished Webflow CMS draft.\n• Item ID: \`${input.itemId}\`\n• Status: Draft only. Publishing remains disabled.` } }
  ];
  if (input.editorUrl) {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Webflow", emoji: true }, url: input.editorUrl }] });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Opens the Webflow Designer for this site. The draft is in the ${collection} collection.` }] });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `Open the ${collection} collection in Webflow and find the item by title.` } });
  }
  return blocks;
}

async function handleConnectCommand(client: WebClient, channel: string, threadTs: string): Promise<void> {
  const result = webflowConnection.createConnectionLink({ channel, threadTs });

  if ("error" in result) {
    await client.chat.postMessage({
      channel,
      text: `Webflow MCP cannot start: ${result.error}`,
      thread_ts: threadTs
    });
    return;
  }

  const connectionCard = await client.chat.postMessage({
    blocks: webflowConnectBlocks(result.link),
    channel,
    text: "Connect Slackflow to Webflow with a one-time OAuth link.",
    thread_ts: threadTs
  });

  if (connectionCard.ts) {
    webflowConnection.recordConnectionMessage(result.requestId, connectionCard.ts);
  }
}

async function handleHttpRequest(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/healthz")) {
    // An uptime monitor must fail when the Slack socket is down, not merely
    // when the HTTP process is alive.
    const unhealthySince = slackDisconnectedSince ?? startedAt;
    const healthy = slackSocketState === "connected" || Date.now() - unhealthySince < SLACK_RECONNECT_GRACE_MS;
    response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    response.end(`${JSON.stringify({
      status: healthy ? "ok" : "degraded",
      slack: slackSocketState === "disconnected" && healthy ? "reconnecting" : slackSocketState,
      webflow: webflowConnection.status().state,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    })}\n`);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/webflow/connect") {
    try {
      const requestId = requestUrl.searchParams.get("request");
      if (!requestId) throw new Error("Missing Webflow connection request.");
      const authorizationUrl = await webflowConnection.startAuthorization(requestId);
      response.writeHead(302, { Location: authorizationUrl });
      response.end();
    } catch (error) {
      app.logger.error("Failed to start Webflow OAuth");
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Webflow connection could not start</h1><p>Return to Slack and run @slackflow connect again.</p>");
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/webflow/oauth/callback") {
    try {
      const requestId = requestUrl.searchParams.get("request");
      if (!requestId) throw new Error("Missing Webflow connection request.");
      const slackContext = await webflowConnection.completeAuthorization(requestId, requestUrl.searchParams);
      if (slackContext) {
        if (slackContext.messageTs) {
          try {
            await app.client.chat.update({
              blocks: webflowConnectedBlocks(),
              channel: slackContext.channel,
              text: "Webflow connected. Run @slackflow schema in this thread to choose the target website and CMS collection.",
              ts: slackContext.messageTs
            });
          } catch {
            app.logger.error("Webflow OAuth completed but the original Slack connection card could not be updated");
            try {
              await app.client.chat.postMessage({
                channel: slackContext.channel,
                thread_ts: slackContext.threadTs,
                blocks: webflowConnectedBlocks(),
                text: ":white_check_mark: Webflow connected. Run @slackflow schema in this thread to choose the target website and CMS collection."
              });
            } catch {
              app.logger.error("Webflow OAuth completed but Slackflow could not post the fallback thread confirmation");
            }
          }
        } else {
          try {
            await app.client.chat.postMessage({
              channel: slackContext.channel,
              thread_ts: slackContext.threadTs,
              blocks: webflowConnectedBlocks(),
              text: ":white_check_mark: Webflow connected. Run @slackflow schema in this thread to choose the target website and CMS collection."
            });
          } catch {
            app.logger.error("Webflow OAuth completed but Slackflow could not post the thread confirmation");
          }
        }
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderWebflowOAuthPage({
        detail: "Slackflow has securely saved the connection and posted a confirmation in your original Slack thread. Return there to choose the website and CMS collection.",
        heading: "Webflow is connected",
        success: true
      }));
    } catch (error) {
      app.logger.error("Failed to complete Webflow OAuth");
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderWebflowOAuthPage({
        detail: "Return to Slack and run @slackflow connect again. No Webflow content was changed.",
        heading: "Webflow connection could not finish",
        success: false
      }));
    }
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end('{"error":"not_found"}\n');
}

/**
 * A draft run takes a model call plus an image generation, so the thread gets
 * live progress instead of silence. Every part is best-effort: the reaction
 * needs the optional `reactions:write` scope, and neither is worth failing a run.
 */
async function startDraftProgress(client: WebClient, input: { channel: string; mentionTs: string; rootTs: string }) {
  const reaction = { channel: input.channel, name: "eyes", timestamp: input.mentionTs };
  await client.reactions.add(reaction).catch(() => undefined);
  const posted = await client.chat
    .postMessage({ channel: input.channel, text: ":hourglass_flowing_sand: Reading this thread…", thread_ts: input.rootTs })
    .catch(() => undefined);

  return {
    async update(text: string): Promise<void> {
      if (!posted?.ts) return;
      await client.chat.update({ channel: input.channel, text, ts: posted.ts }).catch(() => undefined);
    },
    async finish(): Promise<void> {
      await client.reactions.remove(reaction).catch(() => undefined);
      if (!posted?.ts) return;
      await client.chat.delete({ channel: input.channel, ts: posted.ts }).catch(() => undefined);
    }
  };
}

async function getSlackflowBotIdentity(client: WebClient): Promise<{ botId?: string; userId: string }> {
  if (cachedBotIdentity) {
    return cachedBotIdentity;
  }

  const identity = await client.auth.test();

  if (!identity.user_id) {
    throw new Error("Slack auth.test did not return the Slackflow bot user ID.");
  }

  cachedBotIdentity = { botId: identity.bot_id, userId: identity.user_id };
  return cachedBotIdentity;
}

app.event("app_mention", async ({ body, client, event, logger }) => {
  const rootTs = event.thread_ts ?? event.ts;
  const commandKey = `${body.team_id}:${event.channel}:${event.ts}`;

  if (!runStore.claim(body.event_id, commandKey)) {
    logger.info({ commandKey, eventId: body.event_id, rootTs }, "Ignored duplicate Slackflow mention delivery");
    return;
  }

  const command = parseSlackflowCommand(event.text);

  if (command === "connect") {
    try {
      await handleConnectCommand(client, event.channel, rootTs);
    } catch (error) {
      logger.error(error, "Failed to send Webflow OAuth link");
      await client.chat.postMessage({
        channel: event.channel,
        text: ":warning: Slackflow could not send the private Webflow connection link. No Webflow connection was created.",
        thread_ts: rootTs
      });
    }
    runStore.mark(body.event_id, "completed");
    return;
  }

  if (command === "status") {
    await client.chat.postMessage({ channel: event.channel, text: webflowStatusReply(), thread_ts: rootTs });
    runStore.mark(body.event_id, "completed");
    return;
  }

  if (command === "disconnect") {
    const status = webflowConnection.disconnect();
    const text = status.state === "configuration_missing"
      ? `:information_source: Webflow MCP is not configured: ${status.message}`
      : ":white_check_mark: Slackflow removed its encrypted local Webflow connection. This does not revoke the Webflow account's OAuth grant.";
    await client.chat.postMessage({ channel: event.channel, text, thread_ts: rootTs });
    runStore.mark(body.event_id, "completed");
    return;
  }

  if (command === "schema") {
    try {
      if (!event.user) throw new Error("Slack did not provide the user who requested CMS discovery.");
      const sites = webflowSitesFromData((await webflowConnection.listSites()).data);
      if (sites.choices.length === 0) {
        throw new Error("Webflow returned no selectable sites.");
      }
      for (const site of sites.choices) {
        if (site.shortName) siteShortNames.set(site.id, site.shortName);
      }
      await client.chat.postEphemeral({
        channel: event.channel,
        thread_ts: rootTs,
        user: event.user,
        text: "Choose the Webflow site whose CMS Slackflow should inspect. This is read-only.",
        blocks: schemaSelectionBlocks(
          "Choose a Webflow site",
          `This read-only step will list its CMS collections. It will not create, edit, or publish anything.${truncationNote(sites.choices.length, sites.total, "sites")}`,
          "slackflow_select_site",
          sites.choices,
          (site) => site.id
        )
      });
    } catch (error) {
      logger.error(error, "Failed to read Webflow sites");
      await client.chat.postMessage({
        channel: event.channel,
        text: `:warning: Slackflow could not read your Webflow sites. No CMS change was made.\n*Reason:* ${safeWebflowReadError(error)}\nIf this says OAuth is no longer valid, run \`@slackflow connect\` again, complete the browser flow, then retry \`@slackflow schema\`.`,
        thread_ts: rootTs
      });
    }
    runStore.mark(body.event_id, "completed");
    return;
  }

  if (command !== "draft") {
    await client.chat.postMessage({
      channel: event.channel,
      text: command ? commandReply(command) : "Use `@slackflow help` to see the available commands. `@slackflow draft` prepares a strict-transfer proposal plus Slack-only thumbnail and banner previews. Slackflow will not create or change anything in Webflow.",
      thread_ts: rootTs
    });
    runStore.mark(body.event_id, "completed");
    return;
  }

  const progress = await startDraftProgress(client, { channel: event.channel, mentionTs: event.ts, rootTs });

  try {
    const [threadMessages, slackflowBotIdentity] = await Promise.all([
      fetchEntireThread(client, event.channel, rootTs),
      getSlackflowBotIdentity(client)
    ]);

    const transcript = buildThreadTranscript({
      channelId: event.channel,
      invocationTs: event.ts,
      messages: threadMessages,
      rootTs,
      slackflowBotId: slackflowBotIdentity.botId,
      slackflowBotUserId: slackflowBotIdentity.userId
    });

    const participantCount = new Set(transcript.messages.map((message) => message.authorId)).size;

    await progress.update(`:hourglass_flowing_sand: Selecting the draft from ${transcript.messages.length} thread message${transcript.messages.length === 1 ? "" : "s"}…`);
    const extraction = await draftModelProvider.generateDraftProposal({ transcript });

    const previewText = formatProposalPreview(extraction.proposal, transcript.messages.length);

    if (extraction.proposal.status !== "ready") {
      runStore.mark(body.event_id, "blocked");
      await client.chat.postMessage({ channel: event.channel, text: previewText, thread_ts: rootTs });
      return;
    }

    runStore.mark(body.event_id, "draft_ready");

    try {
      await progress.update(":hourglass_flowing_sand: Generating the thumbnail and banner…");
      const imagePreview = await generateSlackImagePreview({
        imageProvider: imageGenerationProvider,
        proposal: extraction.proposal,
        imageSize: config.image.blogImageSize
      });
      runStore.mark(body.event_id, "image_generated");

      try {
        await progress.update(":hourglass_flowing_sand: Uploading the review files…");
        await client.filesUploadV2({
          channel_id: event.channel,
          file_uploads: imagePreview.fileUploads,
          thread_ts: rootTs
        });
      } catch (error) {
        runStore.mark(body.event_id, "image_upload_failed");
        logger.error(error, "Generated Slackflow review files but could not upload them to Slack");
        await client.chat.postMessage({
          channel: event.channel,
          text: ":warning: Slackflow created the reviewed draft but could not upload its Markdown and image to Slack. No Webflow changes were made. Check the service logs for details.",
          thread_ts: rootTs
        });
        return;
      }

      const savedSchema = webflowConnection.getSavedSchema();
      if (savedSchema) {
        try {
          if (!savedSchema.contract) throw new Error("The selected schema has no saved draft contract. Run @slackflow schema again.");
          assertSchemaMatchesContract(savedSchema.schema, savedSchema.contract);
          const mapping = createWebflowDraftMapping({ contract: savedSchema.contract, proposal: extraction.proposal });
          const draftId = storePendingWebflowDraft({
            channel: event.channel,
            collectionName: savedSchema.collectionName,
            contract: savedSchema.contract,
            images: imagePreview.webflowImages,
            mapping,
            proposal: extraction.proposal,
            rootTs,
            siteId: savedSchema.siteId,
            siteShortName: savedSchema.siteShortName ?? (await siteShortName(savedSchema.siteId).catch(() => undefined))
          });
          await client.chat.postMessage({
            blocks: webflowDraftApprovalBlocks({ draftId }),
            channel: event.channel,
            text: "Review the attached Markdown and image, then choose Create Webflow draft.",
            thread_ts: rootTs
          });
        } catch (error) {
          logger.warn(error, "The reviewed Slackflow proposal is not eligible for Webflow creation with the captured schema");
          await client.chat.postMessage({
            channel: event.channel,
            text: `:information_source: The review files are ready, but no Webflow creation button was shown because the captured CMS schema cannot safely map this proposal. *Reason:* ${safeWebflowReadError(error)}`,
            thread_ts: rootTs
          });
        }
      } else {
        await client.chat.postMessage({
          channel: event.channel,
          text: ":information_source: The review files are ready. Run `@slackflow schema` in this thread to select and capture the target CMS collection before Slackflow can offer Webflow draft creation.",
          thread_ts: rootTs
        });
      }

      runStore.mark(body.event_id, "completed");

      logger.info(
        { eventId: body.event_id, imageProviderRequestId: imagePreview.providerRequestIds[0], rootTs },
        "Generated and uploaded Slackflow review files with the draft proposal"
      );
    } catch (error) {
      runStore.mark(body.event_id, "image_generation_failed");
      logger.error(error, "Failed to generate the Slackflow image preview");
      await client.chat.postMessage({
        channel: event.channel,
        text: ":warning: Slackflow could not generate the reviewed Blog Image, so no Webflow draft can be created. Check the service logs for details.",
        thread_ts: rootTs
      });
      return;
    }

    logger.info({
      eventId: body.event_id,
      fetchedMessageCount: transcript.filtering.fetchedMessages,
      messageCount: transcript.messages.length,
      modelProvider: draftModelProvider.id,
      participantCount,
      providerResponseId: extraction.providerResponseId,
      removedAfterInvocationCount: transcript.filtering.removedAfterInvocation,
      removedCommandCount: transcript.filtering.removedCommand,
      removedSlackflowCount: transcript.filtering.removedSlackflow,
      rootTs
    }, "Created Slackflow review proposal");
  } catch (error) {
    runStore.mark(body.event_id, "failed");
    logger.error(error, "Failed to prepare Slackflow draft proposal");

    await client.chat.postMessage({
      channel: event.channel,
      text: ":warning: Slackflow could not prepare a draft proposal. No Webflow changes were made. Check the service logs for the error details.",
      thread_ts: rootTs
    });
  } finally {
    await progress.finish();
  }
});

app.action("slackflow_select_site", async ({ ack, action, body, client, logger }) => {
  await ack();
  const context = actionContext(body);
  const siteId = actionValue(action);
  if (!context || !siteId) return;

  try {
    const collections = webflowCollectionsFromData((await webflowConnection.listCollections(siteId)).data);
    if (collections.choices.length === 0) throw new Error("Webflow returned no selectable CMS collections.");
    await client.chat.postEphemeral({
      channel: context.channel,
      user: context.user,
      thread_ts: context.threadTs,
      text: "Choose the CMS collection Slackflow should inspect. This is read-only.",
      blocks: schemaSelectionBlocks(
        "Choose a CMS collection",
        `Slackflow will read its exact fields and validation rules. It will not create, edit, or publish anything.${truncationNote(collections.choices.length, collections.total, "collections")}`,
        "slackflow_select_collection",
        collections.choices,
        // Slack caps an option value at 75 characters, so two ids travel as a
        // pair rather than as JSON.
        (collection) => `${siteId}:${collection.id}`
      )
    });
  } catch (error) {
    logger.error(error, "Failed to read Webflow CMS collections");
    await client.chat.postEphemeral({ channel: context.channel, user: context.user, text: `:warning: Slackflow could not read CMS collections. No CMS change was made.\n*Reason:* ${safeWebflowReadError(error)}\nRun \`@slackflow schema\` and try again.` });
  }
});

app.action("slackflow_select_collection", async ({ ack, action, body, client, logger }) => {
  await ack();
  const context = actionContext(body);
  const value = actionValue(action);
  if (!context || !value) return;

  try {
    const selection = parseCollectionSelection(value);
    if (!selection) throw new Error("Invalid CMS collection selection.");
    const collectionName = actionSelectedLabel(action);
    const shortName = siteShortNames.get(selection.siteId) ?? (await siteShortName(selection.siteId).catch(() => undefined));
    const details = await webflowConnection.getCollectionDetails(selection.collectionId);
    const fields = fieldLabelsFromWebflowData(details.data);
    const fieldsText = fields.length ? fields.map((field) => `• ${field}`).join("\n") : "• Webflow returned the collection schema, but Slackflow could not summarize its fields.";
    let contract: WebflowDraftContract | undefined;
    let contractText: string;
    try {
      const categoryCollectionId = categoryReferenceCollectionId(details.data);
      const categoryItemIds = categoryCollectionId
        ? verifiedCategoryItemIds((await webflowConnection.listCollectionItems(categoryCollectionId)).data)
        : undefined;
      contract = createWebflowDraftContract({ categoryItemIds, collectionId: selection.collectionId, schema: details.data });
      webflowConnection.saveSchema({ collectionId: selection.collectionId, collectionName, contract, schema: details.data, siteId: selection.siteId, siteShortName: shortName });
      contractText = `*Draft contract:* ready (fingerprint \`${contract.schemaFingerprint.slice(0, 12)}…\`)\nIt fixes Writer to *Datasaur*, accepts only verified Tag option IDs, leaves its approved fields blank, and blocks unexpected required fields. Slackflow will re-check this contract before every create.`;
    } catch (error) {
      webflowConnection.saveSchema({ collectionId: selection.collectionId, collectionName, schema: details.data, siteId: selection.siteId, siteShortName: shortName });
      contractText = `:warning: *Draft contract:* blocked\n${safeWebflowReadError(error)}\nNo Webflow create button will appear until this collection has a safe fixed mapping.`;
    }
    await client.chat.postEphemeral({
      channel: context.channel,
      user: context.user,
      thread_ts: context.threadTs,
      text: contract ? "Slackflow captured the Webflow CMS schema and its draft contract." : "Slackflow captured the Webflow CMS schema, but its draft contract is blocked.",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "CMS schema captured", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `*Collection ID:* \`${selection.collectionId}\`\n*Fields found:*\n${fieldsText}` } },
        { type: "section", text: { type: "mrkdwn", text: contractText } }
      ]
    });
  } catch (error) {
    logger.error(error, "Failed to read Webflow CMS collection schema");
    await client.chat.postEphemeral({ channel: context.channel, user: context.user, text: `:warning: Slackflow could not read this CMS collection schema. No CMS change was made.\n*Reason:* ${safeWebflowReadError(error)}\nRun \`@slackflow schema\` and try again.` });
  }
});

app.action("slackflow_create_webflow_draft", async ({ ack, action, body, client, logger }) => {
  await ack();
  const context = actionContext(body);
  const draftId = actionValue(action);
  if (!context || !draftId) return;

  const pending = loadPendingDraft(draftId, context);
  if (!pending) {
    await client.chat.postMessage({ channel: context.channel, thread_ts: context.threadTs, text: ":information_source: This review approval expired. Run `@slackflow draft` again to create a new review." });
    return;
  }
  if (pending === "wrong_thread") {
    logger.warn({ draftId }, "Rejected a Webflow draft approval outside its original Slack thread");
    return;
  }
  if (draftsInFlight.has(draftId)) return;
  draftsInFlight.add(draftId);
  let createdItem: WebflowCreatedItem | undefined;

  try {
    const liveSchema = await webflowConnection.getCollectionDetails(pending.mapping.collectionId);
    assertSchemaMatchesContract(liveSchema.data, pending.contract);
    const slug = typeof pending.mapping.fieldData.slug === "string" ? pending.mapping.fieldData.slug : undefined;
    // A failed lookup must not block an approved create; it only forfeits the
    // duplicate guard for this attempt.
    const existing = slug
      ? await webflowConnection.findCollectionItemBySlug(pending.mapping.collectionId, slug).catch((error: unknown) => {
        logger.warn(error, "Could not check Webflow for an existing item with the approved slug");
        return undefined;
      })
      : undefined;
    if (existing) {
      // The review is kept: removing the conflicting item in Webflow makes this
      // same button work, with no second model and image run.
      await client.chat.postMessage({
        channel: context.channel,
        thread_ts: pending.rootTs,
        text: `:information_source: Webflow already has an item with the slug \`${slug}\` (\`${existing.id}\`), so Slackflow created nothing. Either that item is this draft from an earlier attempt, or another post shares its title. Open it in Webflow, or change the title in the source thread and run \`@slackflow draft\` again.`
      });
      return;
    }
    let fieldData = pending.mapping.fieldData;
    if (pending.mapping.imageFieldSlugs.main || pending.mapping.imageFieldSlugs.thumbnail) {
      const uploaded = pending.uploadedAssets ?? {};
      for (const kind of ["main", "thumbnail"] as const) {
        if (!pending.mapping.imageFieldSlugs[kind] || uploaded[kind]) continue;
        const image = kind === "main" ? pending.images.banner : pending.images.thumbnail;
        uploaded[kind] = await webflowConnection.uploadImageAsset({
          file: image.file,
          filename: image.filename,
          mimeType: image.mimeType,
          siteId: pending.siteId
        });
        pending.uploadedAssets = uploaded;
        webflowConnection.savePendingDraft(draftId, pending);
      }
      fieldData = applyWebflowImagesToDraft(pending.mapping, {
        ...(uploaded.main ? { main: { ...uploaded.main, altText: pending.images.banner.altText } } : {}),
        ...(uploaded.thumbnail ? { thumbnail: { ...uploaded.thumbnail, altText: pending.images.thumbnail.altText } } : {})
      });
    }
    createdItem = await webflowConnection.createCollectionDraft({ collectionId: pending.mapping.collectionId, fieldData });
    webflowConnection.deletePendingDraft(draftId);
    const title = typeof pending.mapping.fieldData.name === "string" ? pending.mapping.fieldData.name : "Webflow draft";
    const blocks = webflowDraftCreatedBlocks({
      collectionName: pending.collectionName,
      editorUrl: createdItem.editorUrl ?? webflowSiteDesignerUrl(pending.siteShortName),
      itemId: createdItem.id,
      title
    });
    const messageTs = actionMessageTs(body);
    if (messageTs) {
      await client.chat.update({ channel: context.channel, ts: messageTs, text: `Webflow draft created: ${title}`, blocks });
    } else {
      await client.chat.postMessage({ channel: context.channel, thread_ts: pending.rootTs, text: `:white_check_mark: Webflow draft created: ${title}`, blocks });
    }
    logger.info({ collectionId: pending.mapping.collectionId, itemId: createdItem.id, rootTs: pending.rootTs }, "Created approved unpublished Webflow CMS draft");
  } catch (error) {
    logger.error(error, "Failed to create approved Webflow CMS draft");
    const message = error instanceof Error ? error.message : "";
    const nonDraftResult = /not marked as a draft/i.test(message);
    const createdButSlackUpdateFailed = Boolean(createdItem) && !nonDraftResult;
    const retryText = nonDraftResult
      ? "Do not retry this button. Check the item in Webflow first."
      : createdButSlackUpdateFailed
        ? `Webflow returned item \`${createdItem?.id}\`, so do not retry. Check Webflow before taking any further action.`
        : "Press the same Create Webflow draft button again. Slackflow checks the collection for this slug first, so a request that already succeeded is reported instead of repeated.";
    await client.chat.postMessage({
      channel: context.channel,
      thread_ts: pending.rootTs,
      text: `:warning: Slackflow could not confirm the Webflow draft result. *Reason:* ${safeWebflowReadError(error)}\n${retryText}`
    });
  } finally {
    draftsInFlight.delete(draftId);
  }
});

app.action("slackflow_regenerate_webflow_image", async ({ ack, action, body, client, logger }) => {
  await ack();
  const context = actionContext(body);
  const draftId = actionValue(action);
  if (!context || !draftId) return;

  const pending = loadPendingDraft(draftId, context);
  if (!pending) {
    await client.chat.postMessage({ channel: context.channel, thread_ts: context.threadTs, text: ":information_source: This review expired. Run `@slackflow draft` again to create a new review." });
    return;
  }
  if (pending === "wrong_thread") {
    logger.warn({ draftId }, "Rejected a Webflow image regeneration outside its original Slack thread");
    return;
  }
  if (draftsInFlight.has(draftId)) return;
  draftsInFlight.add(draftId);
  const messageTs = actionMessageTs(body);
  let postedNewFiles = false;

  try {
    if (messageTs) {
      await client.chat.update({
        blocks: [{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: Generating a new thumbnail and banner from the same reviewed text…" } }],
        channel: context.channel,
        text: "Generating a new thumbnail and banner…",
        ts: messageTs
      }).catch(() => undefined);
    }

    const imagePreview = await generateSlackImagePreview({
      imageProvider: imageGenerationProvider,
      imageSize: config.image.blogImageSize,
      proposal: pending.proposal
    });
    await client.filesUploadV2({ channel_id: context.channel, file_uploads: imagePreview.fileUploads, thread_ts: pending.rootTs });
    postedNewFiles = true;
    // New bytes invalidate anything already uploaded to Webflow for this review.
    webflowConnection.savePendingDraft(draftId, { ...pending, images: imagePreview.webflowImages, uploadedAssets: undefined });

    const blocks = webflowDraftApprovalBlocks({ draftId });
    if (messageTs) {
      await client.chat.update({ blocks, channel: context.channel, text: "Review the new image, then choose Create Webflow draft.", ts: messageTs });
    } else {
      await client.chat.postMessage({ blocks, channel: context.channel, text: "Review the new image, then choose Create Webflow draft.", thread_ts: pending.rootTs });
    }
    logger.info({ draftId, rootTs: pending.rootTs }, "Regenerated the reviewed Slackflow image");
  } catch (error) {
    logger.error(error, "Failed to regenerate the reviewed Slackflow image");
    const blocks = webflowDraftApprovalBlocks({ draftId });
    if (messageTs) {
      await client.chat.update({ blocks, channel: context.channel, text: "Review the attached Markdown and image, then choose Create Webflow draft.", ts: messageTs }).catch(() => undefined);
    }
    await client.chat.postMessage({
      channel: context.channel,
      thread_ts: pending.rootTs,
      text: postedNewFiles
        ? `:warning: The new files above could not be attached to this review, so *Create Webflow draft* would still use the earlier image. Run \`@slackflow draft\` again for a clean review. No Webflow changes were made. *Reason:* ${safeWebflowReadError(error)}`
        : `:warning: Slackflow could not generate a new image, so the reviewed one is unchanged. No Webflow changes were made. *Reason:* ${safeWebflowReadError(error)}`
    });
  } finally {
    draftsInFlight.delete(draftId);
  }
});

/**
 * The health port opens before Slack does. A Socket Mode handshake can take
 * tens of seconds, and a host that port-scans for readiness must not call that
 * a failed deploy; `/healthz` reports `starting` and turns 503 if the socket
 * never arrives.
 */
async function start(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(config.port, "0.0.0.0", () => {
      healthServer.off("error", reject);
      resolve();
    });
  });
  app.logger.info({ port: config.port }, "Slackflow health endpoint is listening");
  await app.start();
  app.logger.info({ port: config.port }, "⚡️ Slackflow is running in Socket Mode");
}

void start();
