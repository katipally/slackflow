import type { WebClient } from "@slack/web-api";

import type { SlackThreadMessage } from "./thread.js";

function toThreadMessages(messages: unknown[]): SlackThreadMessage[] {
  return messages.map((message) => {
    const candidate = message as {
      bot_id?: string;
      text?: string;
      ts?: string;
      user?: string;
    };

    return {
      bot_id: candidate.bot_id,
      text: candidate.text,
      ts: candidate.ts,
      user: candidate.user
    };
  });
}

/** Fetches every page of a single Slack thread. Transcript filtering happens separately. */
export async function fetchEntireThread(client: WebClient, channel: string, rootTs: string): Promise<SlackThreadMessage[]> {
  const messages: unknown[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.conversations.replies({
      channel,
      cursor,
      limit: 200,
      ts: rootTs
    });

    messages.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return toThreadMessages(messages);
}
