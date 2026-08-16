export type SlackThreadMessage = {
  bot_id?: string;
  text?: string;
  ts?: string;
  user?: string;
};

export type TranscriptMessage = {
  authorId: string;
  isBot: boolean;
  text: string;
  ts: string;
};

export type ThreadTranscript = {
  capturedAt: string;
  channelId: string;
  filtering: TranscriptFiltering;
  invocationTs: string;
  messages: TranscriptMessage[];
  rootTs: string;
};

export type TranscriptFiltering = {
  duplicateMessages: number;
  fetchedMessages: number;
  invalidMessages: number;
  removedAfterInvocation: number;
  removedCommand: number;
  removedSlackflow: number;
};

type BuildThreadTranscriptInput = {
  channelId: string;
  invocationTs: string;
  messages: SlackThreadMessage[];
  slackflowBotId?: string;
  rootTs: string;
  slackflowBotUserId: string;
};

/**
 * Makes a chronological transcript for an invoked thread.
 *
 * The future agent receives all thread participants' content, but never its own
 * prior messages. A later validation layer will treat this transcript as data,
 * never as instructions.
 */
export function buildThreadTranscript({
  channelId,
  invocationTs,
  messages,
  slackflowBotId,
  rootTs,
  slackflowBotUserId
}: BuildThreadTranscriptInput): ThreadTranscript {
  const filtering: TranscriptFiltering = {
    fetchedMessages: messages.length,
    invalidMessages: 0,
    removedSlackflow: 0,
    removedAfterInvocation: 0,
    removedCommand: 0,
    duplicateMessages: 0
  };
  const eligibleMessages: Array<SlackThreadMessage & { ts: string }> = [];

  for (const message of messages) {
    if (!message.ts) {
      filtering.invalidMessages += 1;
    } else if (message.user === slackflowBotUserId || (slackflowBotId && message.bot_id === slackflowBotId)) {
      filtering.removedSlackflow += 1;
    } else if (message.ts > invocationTs) {
      filtering.removedAfterInvocation += 1;
    } else if (message.ts === invocationTs) {
      // The compact @Slackflow command is an authorization signal, not source material.
      filtering.removedCommand += 1;
    } else {
      eligibleMessages.push(message as SlackThreadMessage & { ts: string });
    }
  }

  const seenTimestamps = new Set<string>();
  const transcriptMessages = eligibleMessages
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .filter((message) => {
      if (seenTimestamps.has(message.ts)) {
        filtering.duplicateMessages += 1;
        return false;
      }

      seenTimestamps.add(message.ts);
      return true;
    })
    .map((message) => ({
      authorId: message.user ?? message.bot_id ?? "unknown",
      isBot: Boolean(message.bot_id),
      text: message.text ?? "",
      ts: message.ts
    }));

  return {
    capturedAt: new Date().toISOString(),
    channelId,
    filtering,
    invocationTs,
    messages: transcriptMessages,
    rootTs
  };
}
