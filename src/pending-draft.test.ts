import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { deserializePendingWebflowDraft, serializePendingWebflowDraft, type PendingWebflowDraft } from "./pending-draft.js";

function examplePendingDraft(): PendingWebflowDraft {
  return {
    channel: "C123",
    collectionName: "Forge Blog Posts",
    createAttemptedAt: 1_799_999_999_000,
    contract: { collectionId: "collection-1", schemaFingerprint: "fingerprint" } as PendingWebflowDraft["contract"],
    expiresAt: 1_800_000_000_000,
    images: {
      banner: { altText: "Banner", file: Buffer.from([1, 2, 3]), filename: "post-banner.jpg", mimeType: "image/jpeg" },
      thumbnail: { altText: "Thumbnail", file: Buffer.from([4, 5, 6]), filename: "post-thumbnail.jpg", mimeType: "image/jpeg" }
    },
    mapping: { collectionId: "collection-1", fieldData: { name: "Post", slug: "post" }, imageFieldSlugs: {}, schemaFingerprint: "fingerprint" },
    proposal: { status: "ready" } as PendingWebflowDraft["proposal"],
    rootTs: "1700000000.000100",
    siteId: "site-1",
    siteShortName: "datasaur"
  };
}

test("survives a JSON round trip through SQLite state with its image bytes intact", () => {
  const draft = examplePendingDraft();
  const stored = JSON.parse(JSON.stringify(serializePendingWebflowDraft(draft)));
  const restored = deserializePendingWebflowDraft(stored);

  assert.ok(restored);
  assert.deepEqual(restored.images.banner.file, draft.images.banner.file);
  assert.deepEqual(restored.images.thumbnail.file, draft.images.thumbnail.file);
  assert.equal(restored.images.thumbnail.mimeType, "image/jpeg");
  assert.equal(restored.siteShortName, "datasaur");
  // A recorded attempt is what lets a retry tell a lost response apart from no create at all.
  assert.equal(restored.createAttemptedAt, 1_799_999_999_000);
  assert.equal(restored.mapping.fieldData.slug, "post");
});

test("rejects stored records that lost their images or their thread", () => {
  const stored = JSON.parse(JSON.stringify(serializePendingWebflowDraft(examplePendingDraft()))) as Record<string, unknown>;

  assert.equal(deserializePendingWebflowDraft({ ...stored, images: {} }), undefined);
  assert.equal(deserializePendingWebflowDraft({ ...stored, rootTs: undefined }), undefined);
  assert.equal(deserializePendingWebflowDraft({ ...stored, expiresAt: "soon" }), undefined);
  assert.equal(deserializePendingWebflowDraft(undefined), undefined);
});
