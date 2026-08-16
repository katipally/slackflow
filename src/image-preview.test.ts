import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { generateSlackImagePreview } from "./image-preview.js";
import type { DraftProposal } from "./llm/contracts.js";

const proposal: DraftProposal = {
  mode: "transfer",
  status: "ready",
  fields: {
    title: "Open models shift adoption",
    body_markdown: "A reviewed article body.",
    publication_date: null,
    source_url: null,
    tag: "AI Industry",
    thumbnail_brief: null,
    banner_brief: null
  },
  source_selections: {
    title: { exact_text: "Open models shift adoption", message_timestamp: "1710000000.000000" },
    body_markdown: [{ exact_text: "A reviewed article body.", message_timestamp: "1710000000.000000" }],
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
    reason: "The topic is an AI industry analysis.",
    message_timestamps: ["1710000000.000000"]
  }
};

test("generates a full transferred Markdown file and one 1920x1080 image using the verbatim prompt", async () => {
  const calls: Array<{ prompt: string; size: string }> = [];
  const sourceImage = await sharp({
    create: { width: 1536, height: 1024, channels: 3, background: { r: 0, g: 0, b: 0 } }
  }).jpeg().toBuffer();
  const preview = await generateSlackImagePreview({
    proposal,
    imageSize: "1536x1024",
    imageProvider: {
      id: "fake",
      async generateImage(input) {
        calls.push(input);
        return { base64Data: sourceImage.toString("base64"), mimeType: "image/jpeg", providerRequestId: input.size };
      }
    }
  });

  assert.deepEqual(calls.map((call) => call.size), ["1536x1024"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.prompt ?? "", /"resolution": "1920x1080"/);
  assert.match(calls[0]?.prompt ?? "", /Title: Open models shift adoption/);
  assert.equal(preview.fileUploads.length, 2);
  assert.equal(preview.fileUploads[0]?.filename, "open-models-shift-adoption-draft.md");
  assert.equal(preview.fileUploads[0]?.file.toString("utf8"), "# Open models shift adoption\n\nA reviewed article body.\n");
  assert.equal(preview.fileUploads[1]?.filename, "open-models-shift-adoption-blog-image.jpg");
  const uploadedImage = preview.fileUploads[1]?.file;
  assert.ok(uploadedImage);
  assert.deepEqual(await sharp(uploadedImage).metadata().then(({ width, height }) => ({ width, height })), {
    width: 1920,
    height: 1080
  });
  assert.match(preview.initialComment, /1920x1080/);
  assert.match(preview.initialComment, /no Webflow changes made/);
});
