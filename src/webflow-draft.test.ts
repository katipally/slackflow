import assert from "node:assert/strict";
import test from "node:test";

import { applyWebflowImageToDraft, assertSchemaMatchesContract, createWebflowDraftContract, createWebflowDraftMapping, markdownToWebflowHtml } from "./webflow-draft.js";
import type { DraftProposal } from "./llm/contracts.js";

const proposal = {
  status: "ready",
  fields: { title: "A title", body_markdown: "Line one.\nLine two.", tag: "AI Industry" }
} as DraftProposal;

const schema = {
  fields: [
    { displayName: "Post Body", slug: "post-body", type: "RichText", isRequired: false },
    { displayName: "Main Image", slug: "main-image", type: "Image", isRequired: false },
    { displayName: "Thumbnail image", slug: "thumbnail-image", type: "Image", isRequired: false },
    { displayName: "Writer", slug: "writer", type: "PlainText", isRequired: true },
    { displayName: "Tag", slug: "tag", type: "Option", isRequired: true, metadata: { options: [{ id: "ai", name: "AI Industry" }] } }
  ]
};

test("maps only the fixed verified Forge Blog Post fields and fixes Writer to Datasaur", () => {
  const contract = createWebflowDraftContract({ collectionId: "collection", schema });
  const mapping = createWebflowDraftMapping({ contract, proposal });
  assert.deepEqual(mapping.fieldData, {
    name: "A title",
    slug: "a-title",
    "post-body": "<p>Line one.<br>Line two.</p>",
    writer: "Datasaur",
    tag: "ai"
  });
  assert.deepEqual(mapping.imageFieldSlugs, ["main-image", "thumbnail-image"]);
  assert.deepEqual(applyWebflowImageToDraft(mapping, { id: "asset", url: "https://cdn.example/image.jpg", altText: "Article image" })["main-image"], {
    alt: "Article image", fileId: "asset", url: "https://cdn.example/image.jpg"
  });
});

test("does not guess unexpected required CMS fields", () => {
  assert.throws(() => createWebflowDraftContract({
    collectionId: "collection",
    schema: { fields: [...schema.fields, { displayName: "Required category", slug: "required-category", type: "PlainText", isRequired: true }] }
  }), /will not guess/);
});

test("blocks a changed collection schema after the contract is captured", () => {
  const contract = createWebflowDraftContract({ collectionId: "collection", schema });
  assert.doesNotThrow(() => assertSchemaMatchesContract(schema, contract));
  assert.throws(() => assertSchemaMatchesContract({ fields: [...schema.fields, { displayName: "New field", slug: "new-field", type: "PlainText", isRequired: false }] }, contract), /schema changed/);
});

test("HTML conversion preserves source text without writing new prose", () => {
  assert.equal(markdownToWebflowHtml("A & B\n<literal>"), "<p>A &amp; B<br>&lt;literal&gt;</p>");
});
