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

const app = new App({
  appToken: config.slack.appToken,
  logLevel: LogLevel.INFO,
  socketMode: true,
  token: config.slack.botToken
});

const draftModelProvider = createDraftModelProvider(config.llm);
const imageGenerationProvider = createImageGenerationProvider(config.image);
const runStore = new SlackflowRunStore(config.statePath);
const healthServer = createServer((request, response) => {
  if (request.method === "GET" && (request.url === "/" || request.url === "/healthz")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"ok"}\n');
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end('{"error":"not_found"}\n');
});

let cachedBotIdentity: { botId?: string; userId: string } | undefined;

function commandReply(command: Exclude<SlackflowCommand, "draft" | null>): string {
  switch (command) {
    case "help":
      return [
        "*Slackflow commands*",
        "• `@slackflow draft` prepares a strict-transfer draft, Markdown file, and one Blog Image in this thread.",
        "• `@slackflow status` shows the current Slackflow and Webflow state.",
        "• `@slackflow connect` starts Webflow OAuth after the MCP connection is implemented.",
        "• `@slackflow schema` reads the configured Webflow CMS schema after it is implemented.",
        "• `@slackflow disconnect` removes the stored Webflow connection after it is implemented.",
        "Only `draft`, `help`, and `status` have useful behavior today. Webflow writes are disabled."
      ].join("\n");
    case "status":
      return [
        "*Slackflow status*",
        "• Slack Socket Mode: connected",
        "• Draft generation: available",
        "• Image preview: available for ready drafts",
        "• Webflow MCP OAuth: not implemented",
        "• Webflow CMS schema: not read",
        "• Webflow writes and publishing: disabled"
      ].join("\n");
    case "connect":
      return ":information_source: Webflow OAuth is not implemented yet, so Slackflow cannot connect to Webflow or store a token. No connection was created.";
    case "schema":
      return ":information_source: Webflow MCP is not connected yet, so Slackflow cannot read a CMS schema. No Webflow request was made.";
    case "disconnect":
      return ":information_source: Slackflow has no Webflow connection to remove yet. No token or Webflow setting was changed.";
  }
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
