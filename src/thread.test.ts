import assert from "node:assert/strict";
import test from "node:test";

import { buildThreadTranscript } from "./thread.js";

test("captures every non-Slackflow message in chronological order", () => {
  const transcript = buildThreadTranscript({
    channelId: "C_SANDBOX",
    invocationTs: "1710000003.000000",
    rootTs: "1710000000.000000",
    slackflowBotUserId: "U_SLACKFLOW",
    slackflowBotId: "B_SLACKFLOW",
    messages: [
      { ts: "1710000002.000000", user: "U_WRITER", text: "Draft body" },
      { ts: "1710000000.000000", user: "U_AUTHOR", text: "Original post" },
      { ts: "1710000001.000000", user: "U_REPTAR", bot_id: "B_REPTAR", text: "Metadata" },
      { ts: "1710000003.000000", user: "U_WRITER", text: "<@U_SLACKFLOW> draft" },
      { ts: "1710000004.000000", bot_id: "B_SLACKFLOW", text: "Old reply without a bot user ID" },
      { ts: "1710000005.000000", user: "U_LATE", text: "Message added after invocation" },
      { ts: "1710000002.000000", user: "U_WRITER", text: "Duplicate page result" }
    ]
  });

  assert.deepEqual(transcript.messages, [
    {
      authorId: "U_AUTHOR",
      isBot: false,
      text: "Original post",
      ts: "1710000000.000000"
    },
    {
      authorId: "U_REPTAR",
      isBot: true,
      text: "Metadata",
      ts: "1710000001.000000"
    },
    {
      authorId: "U_WRITER",
      isBot: false,
      text: "Draft body",
      ts: "1710000002.000000"
    }
  ]);
  assert.deepEqual(transcript.filtering, {
    fetchedMessages: 7,
    invalidMessages: 0,
    removedSlackflow: 1,
    removedAfterInvocation: 1,
    removedCommand: 1,
    duplicateMessages: 1
  });
});
