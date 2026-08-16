import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiResponsesProvider } from "./openai-responses-provider.js";
import type { ThreadTranscript } from "../thread.js";

const transcript: ThreadTranscript = {
  capturedAt: "2026-08-15T00:00:00.000Z",
  channelId: "C_SANDBOX",
  filtering: {
    duplicateMessages: 0,
    fetchedMessages: 2,
    invalidMessages: 0,
    removedAfterInvocation: 0,
    removedCommand: 1,
    removedSlackflow: 0
  },
  invocationTs: "1710000001.000000",
  rootTs: "1710000000.000000",
  messages: [
    { authorId: "U_AUTHOR", isBot: false, text: "Draft source", ts: "1710000000.000000" },
    { authorId: "U_AUTHOR", isBot: false, text: "Create draft", ts: "1710000001.000000" }
  ]
};

test("uses the Responses API with GPT-5.6 Luna configuration and no SDK", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;

  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: "resp_test",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    mode: "transfer",
                    status: "ready",
                    source_selections: {
                      title: { message_timestamp: "1710000000.000000", exact_text: "Draft source" },
                      body_markdown: [{ message_timestamp: "1710000000.000000", exact_text: "Draft source" }],
                      publication_date: null,
                      source_url: null,
                      thumbnail_brief: null,
                      banner_brief: null
                    },
                    explicitly_blank: [],
                    missing_fields: [],
                    conflicts: [],
                    notes: [],
                    tag_selection: {
                      selected_tag: "AI Industry",
                      reason: "The source is about the AI industry.",
                      message_timestamps: ["1710000000.000000"]
                    }
                  })
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const result = await provider.generateDraftProposal({ transcript });

  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(requestBody?.model, "gpt-5.6-luna");
  assert.deepEqual(requestBody?.reasoning, { effort: "medium" });
  assert.equal(requestBody?.store, false);
  assert.equal(result.providerResponseId, "resp_test");
  assert.equal(result.proposal.fields.title, "Draft source");
});

test("rejects an unsupported OpenAI reasoning setting before making a request", () => {
  assert.throws(
    () =>
      new OpenAiResponsesProvider({
        apiKey: "test-key",
        model: "gpt-5.6-luna",
        reasoningEffort: "unbounded"
      }),
    /Unsupported OpenAI reasoning effort/
  );
});
