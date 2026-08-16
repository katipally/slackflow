import assert from "node:assert/strict";
import test from "node:test";

import { formatProposalPreview } from "./proposal-preview.js";

test("shows exact transfer-source timestamps and escapes Slack markup", () => {
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

  assert.match(preview, /Thread context at invocation: 3 source messages/);
  assert.match(preview, /Exact transfer sources \(field ← Slack message timestamp\)/);
  assert.match(preview, /Title source ← 1710000001.000000/);
  assert.match(preview, /Body source 1 ← 1710000001.000000/);
  assert.match(preview, /Exact body source segments: 1/);
  assert.match(preview, /Webflow Tag: AI Industry/);
  assert.match(preview, /Tag rationale: The source concerns the AI industry. ← 1710000001.000000/);
  assert.match(preview, /&lt;@U123&gt; &amp; details/);
  assert.match(preview, /Webflow CMS mapping and creation remain disabled/);
});
