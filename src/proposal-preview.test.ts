import assert from "node:assert/strict";
import test from "node:test";

import { formatProposalPreview } from "./proposal-preview.js";

test("shows a compact field checklist and escapes Slack markup", () => {
  const preview = formatProposalPreview(
    {
      mode: "transfer",
      status: "ready",
      fields: {
        title: "A safe title",
        body_markdown: "A body <@U123> & details.",
        publication_date: null,
        source_url: null,
        tag: "AI Industry",
        thumbnail_brief: null,
        banner_brief: null
      },
      source_selections: {
        title: { exact_text: "A safe title", message_timestamp: "1710000001.000000" },
        body_markdown: [{ exact_text: "A body <@U123> & details.", message_timestamp: "1710000001.000000" }],
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
        reason: "The source concerns the AI industry.",
        message_timestamps: ["1710000001.000000"]
      }
    },
    3
  );

  assert.match(preview, /3 source messages read/);
  assert.match(preview, /Fields with values/);
  assert.match(preview, /Slug: a-safe-title/);
  assert.match(preview, /Tag: AI Industry/);
  assert.match(preview, /Post Body: attached Markdown file/);
  assert.match(preview, /Left blank or collection default/);
  assert.doesNotMatch(preview, /A body/);
  assert.match(preview, /real fields are validated/);
});
