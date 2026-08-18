import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { config } from "./config.js";
import { generateSlackImagePreview, type GeneratedImagePreview } from "./image-preview.js";
import { createImageGenerationProvider } from "./images/create-provider.js";
import { createDraftModelProvider } from "./llm/create-provider.js";
import type { DraftProposal } from "./llm/contracts.js";
import { formatProposalPreview } from "./proposal-preview.js";
import { SlackflowRunStore } from "./run-store.js";
import { parseSlackflowCommand, type SlackflowCommand } from "./slack-command.js";
import { fetchEntireThread } from "./slack-thread-collector.js";
import { buildThreadTranscript } from "./thread.js";
import { WebflowMcpConnection, type WebflowCreatedItem } from "./webflow-mcp.js";
import { renderWebflowOAuthPage } from "./webflow-oauth-page.js";
import { applyWebflowImagesToDraft, assertSchemaMatchesContract, categoryReferenceCollectionId, createWebflowDraftContract, createWebflowDraftMapping, verifiedCategoryItemIds, type WebflowDraftContract, type WebflowDraftMapping } from "./webflow-draft.js";

const app = new App({
  appToken: config.slack.appToken,
  logLevel: LogLevel.INFO,
  socketMode: true,
  token: config.slack.botToken
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
const PENDING_WEBFLOW_DRAFT_TTL_MS = 15 * 60 * 1000;

type PendingWebflowDraft = {
  channel: string;
  contract: WebflowDraftContract;
  expiresAt: number;
  images: GeneratedImagePreview["webflowImages"];
  inFlight: boolean;
  mapping: WebflowDraftMapping;
  rootTs: string;
  siteId: string;
  uploadedAssets?: Partial<Record<"main" | "thumbnail", { id: string; url?: string }>>;
};

const pendingWebflowDrafts = new Map<string, PendingWebflowDraft>();

function storePendingWebflowDraft(input: Omit<PendingWebflowDraft, "expiresAt" | "inFlight">): string {
  const now = Date.now();
  for (const [id, pending] of pendingWebflowDrafts) {
    if (pending.expiresAt <= now) pendingWebflowDrafts.delete(id);
  }
  const id = randomUUID();
  pendingWebflowDrafts.set(id, { ...input, expiresAt: now + PENDING_WEBFLOW_DRAFT_TTL_MS, inFlight: false });
  return id;
}

function commandReply(command: Exclude<SlackflowCommand, "connect" | "disconnect" | "draft" | "status" | null>): string {
  switch (command) {
    case "help":
      return [
        "*Slackflow commands*",
        "• `@slackflow draft` prepares a strict-transfer draft, Markdown file, and one Blog Image in this thread.",
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
    "• Slack Socket Mode: connected",
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
    ? `• Webflow CMS schema: read for collection ${schema.collectionId} at ${new Date(schema.readAt).toISOString()}`
    : "• Webflow CMS schema: not read");
  lines.push(schema.state === "read"
    ? "• Webflow drafts: available after Slackflow validates each reviewed proposal and you confirm it"
    : "• Webflow drafts: unavailable until a CMS schema is selected and captured");
  lines.push("• Webflow publishing: disabled");
  return lines.join("\n");
}

type WebflowChoice = { id: string; label: string };

function choicesFromWebflowData(value: unknown): WebflowChoice[] {
  const choices = new Map<string, string>();
  const seen = new Set<unknown>();

  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);

    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const label = [record.displayName, record.name, record.shortName, record.slug]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (id && label) choices.set(id, label.trim());
    Object.values(record).forEach(visit);
  };

  visit(value);
  return [...choices.entries()].slice(0, 100).map(([id, label]) => ({ id, label }));
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

function schemaSelectionBlocks(heading: string, prompt: string, actionId: string, choices: WebflowChoice[], valueFor: (choice: WebflowChoice) => string) {
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

function safeWebflowReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Webflow MCP error.";
  const safeMessage = message
    .replace(/(access[_-]?token|refresh[_-]?token|authorization|bearer)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/g, "[URL redacted]")
    .slice(0, 350);

  if (/create_collection_items/i.test(safeMessage) && /expected.*array/i.test(safeMessage)) {
    return "Webflow MCP rejected the CMS draft payload. Deploy the current Slackflow update, then retry the same approval once.";
  }

  if (/path.*actions|expected.*array|received.*undefined/i.test(safeMessage)) {
    return "Webflow MCP rejected the site-discovery request. Deploy the current Slackflow update, then retry the command.";
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

function webflowDraftApprovalBlocks(input: { draftId: string; mapping: WebflowDraftMapping }) {
  return [
    { type: "header" as const, text: { type: "plain_text" as const, text: "Create Webflow draft?", emoji: true } },
    { type: "section" as const, text: { type: "mrkdwn" as const, text: "Review the attached Markdown, Thumbnail Image, and Banner Image. This creates one *unpublished* CMS draft and never publishes it." } },
    {
      type: "actions" as const,
      elements: [{
        type: "button" as const,
        action_id: "slackflow_create_webflow_draft",
        style: "primary" as const,
        text: { type: "plain_text" as const, text: "Create Webflow draft", emoji: true },
        value: input.draftId,
        confirm: {
          title: { type: "plain_text" as const, text: "Create unpublished Webflow draft?", emoji: true },
          text: { type: "mrkdwn" as const, text: "Slackflow will upload the reviewed thumbnail and banner, then create one CMS item as a draft. It will not publish it." },
          confirm: { type: "plain_text" as const, text: "Create draft", emoji: true },
          deny: { type: "plain_text" as const, text: "Cancel", emoji: true }
        }
      }]
    }
  ];
}

function webflowDraftCreatedBlocks(input: { itemId: string; title: string; editorUrl?: string }): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Webflow draft created", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *${input.title}* was created as an unpublished Webflow CMS draft.\n• Item ID: \`${input.itemId}\`\n• Status: Draft only. Publishing remains disabled.` } }
  ];
  if (input.editorUrl) {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Webflow draft", emoji: true }, url: input.editorUrl }] });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "Webflow did not return a direct editor URL. Open the selected Forge Blog Posts collection in Webflow and find the item by title." } });
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
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"ok"}\n');
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
      const sites = choicesFromWebflowData((await webflowConnection.listSites()).data);
      if (sites.length === 0) {
        throw new Error("Webflow returned no selectable sites.");
      }
      await client.chat.postEphemeral({
        channel: event.channel,
        thread_ts: rootTs,
        user: event.user,
        text: "Choose the Webflow site whose CMS Slackflow should inspect. This is read-only.",
        blocks: schemaSelectionBlocks("Choose a Webflow site", "This read-only step will list its CMS collections. It will not create, edit, or publish anything.", "slackflow_select_site", sites, (site) => site.id)
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
      text: command ? commandReply(command) : "Use `@slackflow help` to see the available commands. `@slackflow draft` prepares a strict-transfer proposal and one Slack-only Blog Image preview. Slackflow will not create or change anything in Webflow.",
      thread_ts: rootTs
    });
    runStore.mark(body.event_id, "completed");
    return;
  }

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

    const extraction = await draftModelProvider.generateDraftProposal({ transcript });

    const previewText = formatProposalPreview(extraction.proposal, transcript.messages.length);

    if (extraction.proposal.status !== "ready") {
      runStore.mark(body.event_id, "blocked");
      await client.chat.postMessage({ channel: event.channel, text: previewText, thread_ts: rootTs });
      return;
    }

    runStore.mark(body.event_id, "draft_ready");

    try {
      const imagePreview = await generateSlackImagePreview({
        imageProvider: imageGenerationProvider,
        proposal: extraction.proposal,
        imageSize: config.image.blogImageSize
      });
      runStore.mark(body.event_id, "image_generated");

      try {
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
            contract: savedSchema.contract,
            images: imagePreview.webflowImages,
            mapping,
            rootTs,
            siteId: savedSchema.siteId
          });
          await client.chat.postMessage({
            blocks: webflowDraftApprovalBlocks({ draftId, mapping }),
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
      text: ":warning: Slackflow could not prepare a draft proposal. No Webflow changes were made. Check the local terminal for the error details.",
      thread_ts: rootTs
    });
  }
});

app.action("slackflow_select_site", async ({ ack, action, body, client, logger }) => {
  await ack();
  const context = actionContext(body);
  const siteId = actionValue(action);
  if (!context || !siteId) return;

  try {
    const collections = choicesFromWebflowData((await webflowConnection.listCollections(siteId)).data);
    if (collections.length === 0) throw new Error("Webflow returned no selectable CMS collections.");
    await client.chat.postEphemeral({
      channel: context.channel,
      user: context.user,
      thread_ts: context.threadTs,
      text: "Choose the CMS collection Slackflow should inspect. This is read-only.",
      blocks: schemaSelectionBlocks("Choose a CMS collection", "Slackflow will read its exact fields and validation rules. It will not create, edit, or publish anything.", "slackflow_select_collection", collections, (collection) => JSON.stringify({ collectionId: collection.id, siteId }))
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
    const selection = JSON.parse(value) as { collectionId?: unknown; siteId?: unknown };
    if (typeof selection.collectionId !== "string" || typeof selection.siteId !== "string") throw new Error("Invalid CMS collection selection.");
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
      webflowConnection.saveSchema(selection.siteId, selection.collectionId, details.data, contract);
      contractText = `*Draft contract:* ready (fingerprint \`${contract.schemaFingerprint.slice(0, 12)}…\`)\nIt fixes Writer to *Datasaur*, accepts only verified Tag option IDs, leaves its approved fields blank, and blocks unexpected required fields. Slackflow will re-check this contract before every create.`;
    } catch (error) {
      webflowConnection.saveSchema(selection.siteId, selection.collectionId, details.data);
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

  const pending = pendingWebflowDrafts.get(draftId);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingWebflowDrafts.delete(draftId);
    await client.chat.postMessage({ channel: context.channel, thread_ts: context.threadTs, text: ":information_source: This review approval has expired or Slackflow restarted. Run `@slackflow draft` again to create a new review." });
    return;
  }
  if (pending.channel !== context.channel || pending.rootTs !== context.threadTs) {
    logger.warn({ draftId }, "Rejected a Webflow draft approval outside its original Slack thread");
    return;
  }
  if (pending.inFlight) return;
  pending.inFlight = true;
  let createdItem: WebflowCreatedItem | undefined;

  try {
    const liveSchema = await webflowConnection.getCollectionDetails(pending.mapping.collectionId);
    assertSchemaMatchesContract(liveSchema.data, pending.contract);
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
      }
      fieldData = applyWebflowImagesToDraft(pending.mapping, {
        ...(uploaded.main ? { main: { ...uploaded.main, altText: pending.images.banner.altText } } : {}),
        ...(uploaded.thumbnail ? { thumbnail: { ...uploaded.thumbnail, altText: pending.images.thumbnail.altText } } : {})
      });
    }
    createdItem = await webflowConnection.createCollectionDraft({ collectionId: pending.mapping.collectionId, fieldData });
    pendingWebflowDrafts.delete(draftId);
    const title = typeof pending.mapping.fieldData.name === "string" ? pending.mapping.fieldData.name : "Webflow draft";
    const blocks = webflowDraftCreatedBlocks({ itemId: createdItem.id, title, editorUrl: createdItem.editorUrl });
    const messageTs = actionMessageTs(body);
    if (messageTs) {
      await client.chat.update({ channel: context.channel, ts: messageTs, text: `Webflow draft created: ${title}`, blocks });
    } else {
      await client.chat.postMessage({ channel: context.channel, thread_ts: pending.rootTs, text: `:white_check_mark: Webflow draft created: ${title}`, blocks });
    }
    logger.info({ collectionId: pending.mapping.collectionId, itemId: createdItem.id, rootTs: pending.rootTs }, "Created approved unpublished Webflow CMS draft");
  } catch (error) {
    if (pendingWebflowDrafts.has(draftId)) pending.inFlight = false;
    logger.error(error, "Failed to create approved Webflow CMS draft");
    const message = error instanceof Error ? error.message : "";
    const nonDraftResult = /not marked as a draft/i.test(message);
    const createdButSlackUpdateFailed = Boolean(createdItem) && !nonDraftResult;
    const retryText = nonDraftResult
      ? "Do not retry this button. Check the item in Webflow first."
      : createdButSlackUpdateFailed
        ? `Webflow returned item \`${createdItem?.id}\`, so do not retry. Check Webflow before taking any further action.`
        : "If Webflow shows no new item, you can try the same Create Webflow draft button again. If the request may have timed out, check Webflow first to avoid a duplicate.";
    await client.chat.postMessage({
      channel: context.channel,
      thread_ts: pending.rootTs,
      text: `:warning: Slackflow could not confirm the Webflow draft result. *Reason:* ${safeWebflowReadError(error)}\n${retryText}`
    });
  }
});

async function start(): Promise<void> {
  await app.start();
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(config.port, "0.0.0.0", () => {
      healthServer.off("error", reject);
      resolve();
    });
  });
  app.logger.info({ port: config.port }, "⚡️ Slackflow is running in Socket Mode");
}

void start();
