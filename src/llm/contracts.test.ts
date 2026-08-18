import assert from "node:assert/strict";
import test from "node:test";

import { parseDraftProposal } from "./contracts.js";
import type { ThreadTranscript } from "../thread.js";

const rootSource = "Exact title\n\nExact first paragraph about the AI industry.\n\nExact second paragraph.";
const title = "Exact title";
const firstParagraph = "Exact first paragraph about the AI industry.";
const secondParagraph = "Exact second paragraph.";

const transcript: ThreadTranscript = {
  capturedAt: "2026-08-15T00:00:00.000Z",
  channelId: "C_SANDBOX",
  filtering: {
    duplicateMessages: 0,
    fetchedMessages: 3,
    invalidMessages: 0,
    removedAfterInvocation: 0,
    removedCommand: 1,
    removedSlackflow: 0
  },
  invocationTs: "1710000002.000000",
  rootTs: "1710000000.000000",
  messages: [
    { authorId: "U_AUTHOR", isBot: false, text: rootSource, ts: "1710000000.000000" },
    { authorId: "U_WRITER", isBot: false, text: "Please prepare this exact draft.", ts: "1710000001.000000" },
    { authorId: "U_AUTHOR", isBot: false, text: "Create draft", ts: "1710000002.000000" }
  ]
};

function source(exactText: string, messageTimestamp = "1710000000.000000") {
  return { message_timestamp: messageTimestamp, exact_text: exactText };
}

function readyOutput(): Record<string, unknown> {
  return {
    mode: "transfer",
    status: "ready",
    source_selections: {
      title: source(title),
      body_markdown: [source(firstParagraph), source(secondParagraph)],
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
      reason: "The exact body text is an AI industry topic.",
      message_timestamps: ["1710000000.000000"]
    }
  };
}

test("derives a ready proposal solely from exact selected Slack text", () => {
  const proposal = parseDraftProposal(JSON.stringify(readyOutput()), transcript);

  assert.equal(proposal.status, "ready");
  assert.equal(proposal.fields.title, title);
  assert.equal(proposal.fields.body_markdown, `${firstParagraph}\n\n${secondParagraph}`);
  assert.equal(proposal.fields.tag, "AI Industry");
  assert.deepEqual(proposal.source_selections.body_markdown.map((segment) => segment.exact_text), [
    firstParagraph,
    secondParagraph
  ]);
});

test("removes only outer Markdown title wrappers and a trailing assistant option menu", () => {
  const sourceText = "_Exact title_\n\nExact article paragraph.\n\nIf you want, I can also:\n1. make this shorter\n2. create it in Notion";
  const menuTranscript: ThreadTranscript = {
    ...transcript,
    messages: [{ authorId: "U_AUTHOR", isBot: false, text: sourceText, ts: "1710000000.000000" }]
  };
  const output = readyOutput();
  const selections = output.source_selections as Record<string, unknown>;
  selections.title = source("_Exact title_");
  selections.body_markdown = [source("Exact article paragraph.\n\nIf you want, I can also:\n1. make this shorter\n2. create it in Notion")];
  const proposal = parseDraftProposal(JSON.stringify(output), menuTranscript);

  assert.equal(proposal.fields.title, "Exact title");
  assert.equal(proposal.source_selections.title?.exact_text, "_Exact title_");
  assert.equal(proposal.fields.body_markdown, "Exact article paragraph.");
});

test("rejects blog content that is not an exact substring of its cited Slack message", () => {
  const output = readyOutput();
  const selections = output.source_selections as Record<string, unknown>;
  selections.body_markdown = [source("A fabricated replacement paragraph.")];

  assert.throws(
    () => parseDraftProposal(JSON.stringify(output), transcript),
    /not an exact source substring/
  );
});

test("ignores any untrusted free-form fields object and derives fields from selections", () => {
  const output = readyOutput();
  output.fields = {
    title: "A fabricated title that must never be used.",
    body_markdown: "A fabricated body that must never be used.",
    tag: "Datasaur"
  };

  const proposal = parseDraftProposal(JSON.stringify(output), transcript);
  assert.equal(proposal.fields.title, title);
  assert.equal(proposal.fields.body_markdown, `${firstParagraph}\n\n${secondParagraph}`);
  assert.equal(proposal.fields.tag, "AI Industry");
});

test("rejects a model attempt to use the retired compose mode", () => {
  const output = readyOutput();
  output.mode = "compose";

  assert.throws(
    () => parseDraftProposal(JSON.stringify(output), transcript),
    /unsupported draft mode/
  );
});

test("rejects body source segments that reorder the captured thread", () => {
  const output = readyOutput();
  const selections = output.source_selections as Record<string, unknown>;
  selections.body_markdown = [source(secondParagraph), source(firstParagraph)];

  assert.throws(
    () => parseDraftProposal(JSON.stringify(output), transcript),
    /changed the original order/
  );
});

test("rejects an invented Webflow tag and blocks an uncertain classification", () => {
  const inventedTagOutput = readyOutput();
  inventedTagOutput.tag_selection = {
    selected_tag: "Made Up Tag",
    reason: "Not a configured option.",
    message_timestamps: ["1710000000.000000"]
  };

  assert.throws(
    () => parseDraftProposal(JSON.stringify(inventedTagOutput), transcript),
    /invalid tag_selection.selected_tag/
  );

  const uncertainOutput = readyOutput();
  uncertainOutput.status = "needs_input";
  uncertainOutput.missing_fields = ["tag"];
  uncertainOutput.tag_selection = { selected_tag: null, reason: null, message_timestamps: [] };

  const uncertainProposal = parseDraftProposal(JSON.stringify(uncertainOutput), transcript);
  assert.equal(uncertainProposal.status, "needs_input");
  assert.equal(uncertainProposal.fields.tag, null);
});

test("blocks incomplete transfer source text instead of drafting the missing body", () => {
  const output = readyOutput();
  output.status = "needs_input";
  output.missing_fields = ["body_markdown"];
  const selections = output.source_selections as Record<string, unknown>;
  selections.body_markdown = [];

  const proposal = parseDraftProposal(JSON.stringify(output), transcript);
  assert.equal(proposal.status, "needs_input");
  assert.equal(proposal.fields.body_markdown, null);
});
