import assert from "node:assert/strict";
import test from "node:test";

import { fetchEntireThread } from "./slack-thread-collector.js";

test("fetches and combines every page of an invoked Slack thread", async () => {
  const receivedCursors: Array<string | undefined> = [];
  const client = {
    conversations: {
      replies: async ({ cursor }: { cursor?: string }) => {
        receivedCursors.push(cursor);

        if (!cursor) {
          return {
            messages: [{ ts: "1710000000.000000", user: "U_ROOT", text: "Root" }],
            response_metadata: { next_cursor: "page-two" }
          };
        }

        return {
          messages: [{ ts: "1710000001.000000", user: "U_REPLY", text: "Reply" }],
          response_metadata: { next_cursor: "" }
        };
      }
    }
  };

  const messages = await fetchEntireThread(client as never, "C_SANDBOX", "1710000000.000000");

  assert.deepEqual(receivedCursors, [undefined, "page-two"]);
  assert.deepEqual(messages.map((message) => message.text), ["Root", "Reply"]);
});
