import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { createServer } from "node:http";

import { config } from "./config.js";
import { generateSlackImagePreview } from "./image-preview.js";
import { createImageGenerationProvider } from "./images/create-provider.js";
import { createDraftModelProvider } from "./llm/create-provider.js";
import { formatProposalPreview } from "./proposal-preview.js";
import { SlackflowRunStore } from "./run-store.js";
import { parseSlackflowCommand, type SlackflowCommand } from "./slack-command.js";
import { fetchEntireThread } from "./slack-thread-collector.js";
import { buildThreadTranscript } from "./thread.js";
import { WebflowMcpConnection } from "./webflow-mcp.js";

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

function commandReply(command: Exclude<SlackflowCommand, "connect" | "disconnect" | "draft" | "status" | null>): string {
  switch (command) {
    case "help":
      return [
        "*Slackflow commands*",
        "• `@slackflow draft` prepares a strict-transfer draft, Markdown file, and one Blog Image in this thread.",
        "• `@slackflow status` shows the current Slackflow and Webflow state.",
        "• `@slackflow connect` sends a private one-time Webflow OAuth link.",
        "• `@slackflow schema` reads a selected Webflow CMS schema only.",
        "• `@slackflow disconnect` removes Slackflow's encrypted local Webflow connection.",
        "Webflow writes are disabled."
      ].join("\n");
    case "schema":
      return ":information_source: CMS schema discovery is not implemented yet. Webflow writes remain disabled.";
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
  lines.push("• Webflow writes and publishing: disabled");
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
  return [...choices.entries()].slice(0, 25).map(([id, label]) => ({ id, label }));
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
      elements: choices.map((choice) => ({
        type: "button" as const,
        action_id: actionId,
        text: { type: "plain_text" as const, text: choice.label.slice(0, 75), emoji: true },
        value: valueFor(choice)
      }))
    }
  ];
}

function actionContext(body: unknown): { channel: string; threadTs?: string; user: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = body as { channel?: { id?: unknown }; container?: { thread_ts?: unknown }; user?: { id?: unknown } };
  if (typeof value.channel?.id !== "string" || typeof value.user?.id !== "string") return undefined;
  return { channel: value.channel.id, threadTs: typeof value.container?.thread_ts === "string" ? value.container.thread_ts : undefined, user: value.user.id };
}

function actionValue(action: unknown): string | undefined {
  return action && typeof action === "object" && "value" in action && typeof action.value === "string" ? action.value : undefined;
}

async function handleConnectCommand(client: WebClient, channel: string, user: string): Promise<void> {
  const result = webflowConnection.createConnectionLink();

  if ("error" in result) {
    await client.chat.postEphemeral({
      channel,
      text: `Webflow MCP cannot start: ${result.error}`,
      user
    });
    return;
  }

  await client.chat.postEphemeral({
    blocks: [
      {
        text: { emoji: true, text: "Connect Slackflow to Webflow", type: "plain_text" },
        type: "header"
      },
      {
        text: {
          text: "This one-time link expires in 10 minutes. Complete Webflow OAuth in your browser. Slackflow will store the resulting token encrypted in its local SQLite state. It will not read a CMS schema or make any Webflow change yet.",
          type: "mrkdwn"
        },
        type: "section"
      },
      {
        elements: [{ text: { emoji: true, text: "Connect Webflow", type: "plain_text" }, type: "button", url: result.link }],
        type: "actions"
      }
    ],
    channel,
    text: `Open this one-time Webflow connection link: ${result.link}`,
    user
  });
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
      await webflowConnection.completeAuthorization(requestId, requestUrl.searchParams);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Webflow connected</h1><p>You can return to Slack and run @slackflow status.</p>");
    } catch (error) {
      app.logger.error("Failed to complete Webflow OAuth");
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Webflow connection could not finish</h1><p>Return to Slack and run @slackflow connect again.</p>");
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
      if (!event.user) {
        throw new Error("Slack did not provide the user who requested Webflow OAuth.");
      }
      await handleConnectCommand(client, event.channel, event.user);
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
        user: event.user,
        text: "Choose the Webflow site whose CMS Slackflow should inspect. This is read-only.",
        blocks: schemaSelectionBlocks("Choose a Webflow site", "This read-only step will list its CMS collections. It will not create, edit, or publish anything.", "slackflow_select_site", sites, (site) => site.id)
      });
    } catch (error) {
      logger.error(error, "Failed to read Webflow sites");
      await client.chat.postMessage({
        channel: event.channel,
        text: ":warning: Slackflow could not read your Webflow sites. No CMS change was made. Check that Webflow is connected, then run `@slackflow schema` again.",
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

    await client.chat.postMessage({
      channel: event.channel,
      text: `:hourglass_flowing_sand: Reading ${transcript.messages.length} source messages and preparing a strict-transfer draft plus one Blog Image preview…`,
      thread_ts: rootTs
    });

    const extraction = await draftModelProvider.generateDraftProposal({ transcript });

    const previewText = formatProposalPreview(extraction.proposal, transcript.messages.length);

    if (extraction.proposal.status !== "ready") {
      runStore.mark(body.event_id, "blocked");
      await client.chat.postMessage({ channel: event.channel, text: previewText, thread_ts: rootTs });
      return;
    }

    runStore.mark(body.event_id, "draft_ready");

    await client.chat.postMessage({
      channel: event.channel,
      text: ":art: Strict-transfer proposal is ready. Generating its one Slack-only Blog Image preview…",
      thread_ts: rootTs
    });

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
          initial_comment: `${previewText}\n\n${imagePreview.initialComment}`,
          thread_ts: rootTs
        });
      } catch (error) {
        runStore.mark(body.event_id, "image_upload_failed");
        logger.error(error, "Generated Slackflow review files but could not upload them to Slack");
        await client.chat.postMessage({
          channel: event.channel,
          text: `${previewText}\n\n:warning: The strict-transfer draft is ready, but its review files could not be uploaded to Slack. No Webflow changes were made. Check the local terminal for the error details.`,
          thread_ts: rootTs
        });
        return;
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
        text: `${previewText}\n\n:warning: The strict-transfer draft is ready, but Slackflow could not generate its Blog Image. No Webflow changes were made. Check the local terminal for the error details.`,
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
    }, "Created no-write Slackflow draft proposal");
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
    await client.chat.postEphemeral({ channel: context.channel, user: context.user, text: ":warning: Slackflow could not read CMS collections. No CMS change was made. Run `@slackflow schema` and try again." });
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
    webflowConnection.saveSchema(selection.siteId, selection.collectionId, details.data);
    const fields = fieldLabelsFromWebflowData(details.data);
    const fieldsText = fields.length ? fields.map((field) => `• ${field}`).join("\n") : "• Webflow returned the collection schema, but Slackflow could not summarize its fields.";
    await client.chat.postEphemeral({
      channel: context.channel,
      user: context.user,
      thread_ts: context.threadTs,
      text: "Slackflow captured the Webflow CMS schema. CMS writes are still disabled.",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "CMS schema captured", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `*Collection ID:* \`${selection.collectionId}\`\n*Fields found:*\n${fieldsText}` } },
        { type: "section", text: { type: "mrkdwn", text: "Next, Slackflow will validate a fixed field mapping against this exact schema. It will not create a CMS item until that mapping is complete and you explicitly confirm the draft." } }
      ]
    });
  } catch (error) {
    logger.error(error, "Failed to read Webflow CMS collection schema");
    await client.chat.postEphemeral({ channel: context.channel, user: context.user, text: ":warning: Slackflow could not read this CMS collection schema. No CMS change was made. Run `@slackflow schema` and try again." });
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
