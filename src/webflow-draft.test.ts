import assert from "node:assert/strict";
import test from "node:test";

import { applyWebflowImagesToDraft, assertSchemaMatchesContract, createExtractivePostSummary, createWebflowDraftContract, createWebflowDraftMapping, markdownToWebflowHtml, verifiedCategoryItemIds } from "./webflow-draft.js";
import type { DraftProposal } from "./llm/contracts.js";

const proposal = {
  status: "ready",
  fields: { title: "A title", body_markdown: "Line one.\nLine two.", tag: "AI Industry" }
} as DraftProposal;

const schema = {
  fields: [
    { displayName: "Post Body", slug: "post-body", type: "RichText", isRequired: false },
    { displayName: "Post Summary", slug: "post-summary", type: "PlainText", isRequired: false },
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
    "post-summary": "Line one. Line two.",
    writer: "Datasaur",
    tag: "ai"
  });
  assert.deepEqual(mapping.imageFieldSlugs, { main: "main-image", thumbnail: "thumbnail-image" });
  assert.deepEqual(applyWebflowImagesToDraft(mapping, {
    main: { id: "banner", url: "https://cdn.example/banner.jpg", altText: "Banner" },
    thumbnail: { id: "asset", url: "https://cdn.example/image.jpg", altText: "Article image" }
  })["main-image"], {
    alt: "Banner", fileId: "banner", url: "https://cdn.example/banner.jpg"
  });
  assert.deepEqual(applyWebflowImagesToDraft(mapping, {
    main: { id: "banner", url: "https://cdn.example/banner.jpg", altText: "Banner" },
    thumbnail: { id: "asset", url: "https://cdn.example/image.jpg", altText: "Article image" }
  })["thumbnail-image"], {
    alt: "Article image", fileId: "asset", url: "https://cdn.example/image.jpg"
  });
});

test("maps provided date and source fields only when the selected schema exposes them", () => {
  const contract = createWebflowDraftContract({
    collectionId: "collection",
    schema: {
      fields: [
        ...schema.fields,
        { displayName: "Created On (Inputted)", slug: "created-on-inputted", type: "Date", isRequired: false },
        { displayName: "Source URL", slug: "source-url", type: "Link", isRequired: false }
      ]
    }
  });
  const mapping = createWebflowDraftMapping({
    contract,
    proposal: {
      ...proposal,
      fields: { ...proposal.fields, publication_date: "2026-08-15", source_url: "https://example.com/source" }
    } as DraftProposal
  });
  assert.equal(mapping.fieldData["created-on-inputted"], "2026-08-15");
  assert.equal(mapping.fieldData["source-url"], "https://example.com/source");
  assert.equal(contract.approvedBlankFields.includes("Created On (Inputted)"), false);
});

test("leaves an optional Date/Time field blank when the source has only a date", () => {
  const contract = createWebflowDraftContract({
    collectionId: "collection",
    schema: {
      fields: [...schema.fields, { displayName: "Publication Date", slug: "publication-date", type: "Date/Time", isRequired: false }]
    }
  });
  const mapping = createWebflowDraftMapping({
    contract,
    proposal: { ...proposal, fields: { ...proposal.fields, publication_date: "2026-08-15" } } as DraftProposal
  });
  assert.equal(Object.hasOwn(mapping.fieldData, "publication-date"), false);
});

test("blocks a date-only source for a required Date/Time CMS field", () => {
  const contract = createWebflowDraftContract({
    collectionId: "collection",
    schema: {
      fields: [...schema.fields, { displayName: "Publication Date", slug: "publication-date", type: "Date/Time", isRequired: true }]
    }
  });
  assert.throws(() => createWebflowDraftMapping({
    contract,
    proposal: { ...proposal, fields: { ...proposal.fields, publication_date: "2026-08-15" } } as DraftProposal
  }), /required Webflow Date\/Time field/);
});

test("blocks a non-URL source value for a Webflow Link field", () => {
  const contract = createWebflowDraftContract({
    collectionId: "collection",
    schema: {
      fields: [...schema.fields, { displayName: "Source URL", slug: "source-url", type: "Link", isRequired: false }]
    }
  });
  assert.throws(() => createWebflowDraftMapping({
    contract,
    proposal: { ...proposal, fields: { ...proposal.fields, source_url: "<https://example.com|source>" } } as DraftProposal
  }), /will not rewrite/);
});

test("blocks a required source field when the reviewed thread did not provide one", () => {
  const contract = createWebflowDraftContract({
    collectionId: "collection",
    schema: {
      fields: [...schema.fields, { displayName: "Source URL", slug: "source-url", type: "Link", isRequired: true }]
    }
  });
  assert.throws(() => createWebflowDraftMapping({ contract, proposal }), /requires a source URL/);
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

test("HTML conversion deterministically preserves headings, lists, links, and inline formatting", () => {
  assert.equal(
    markdownToWebflowHtml("# Heading\n\n- One\n- Two\n\n**bold** and [source](https://example.com)"),
    '<h1>Heading</h1><ul><li>One</li><li>Two</li></ul><p><strong>bold</strong> and <a href="https://example.com">source</a></p>'
  );
});

test("HTML conversion uses a standalone italic source line as an H2 without changing its text", () => {
  assert.equal(markdownToWebflowHtml("Opening text.\n\n*Source signalled section*\n\nClosing text."), "<p>Opening text.</p><h2>Source signalled section</h2><p>Closing text.</p>");
});

test("maps an exact verified Category item matching the approved Tag", () => {
  const categoryItems = verifiedCategoryItemIds({ items: [{ id: "category-ai", fieldData: { name: "AI Industry" } }] });
  const contract = createWebflowDraftContract({
    categoryItemIds: categoryItems,
    collectionId: "collection",
    schema: { fields: [...schema.fields, { displayName: "Category", slug: "category", type: "MultiReference", isRequired: false, metadata: { collectionId: "categories" } }] }
  });
  assert.deepEqual(createWebflowDraftMapping({ contract, proposal }).fieldData.category, ["category-ai"]);
});

test("extractive post summary copies only text from the reviewed body", () => {
  assert.equal(createExtractivePostSummary("First source sentence. Second source sentence. Third source sentence."), "First source sentence. Second source sentence.");
});
