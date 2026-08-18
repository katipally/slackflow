import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PendingWebflowDraft } from "./pending-draft.js";
import { WebflowConnectionStore } from "./webflow-connection-store.js";
import {
  createWebflowCollectionDraftAction,
  createWebflowDataToolRequest,
  findItemWithSlug,
  WebflowMcpConnection,
  webflowS3FieldName
} from "./webflow-mcp.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");

test("builds hosted Webflow data-tool requests with required context and action label", () => {
  assert.deepEqual(
    createWebflowDataToolRequest("List sites for target selection.", "List accessible Webflow sites", { list_sites: {} }),
    {
      actions: [{ label: "List accessible Webflow sites", list_sites: {} }],
      context: "List sites for target selection."
    }
  );
});

test("normalizes MCP camelCase asset fields to the exact S3 signed field names", () => {
  assert.equal(webflowS3FieldName("cacheControl"), "Cache-Control");
  assert.equal(webflowS3FieldName("contentType"), "content-type");
  assert.equal(webflowS3FieldName("successActionStatus"), "success_action_status");
  assert.equal(webflowS3FieldName("xAmzAlgorithm"), "X-Amz-Algorithm");
  assert.equal(webflowS3FieldName("X-Amz-Signature"), "X-Amz-Signature");
  assert.equal(webflowS3FieldName("acl"), "acl");
});

test("creates exactly one CMS draft in the MCP bulk fieldData array", () => {
  assert.deepEqual(createWebflowCollectionDraftAction("collection-1", { name: "New draft", slug: "new-draft" }), {
    create_collection_items: {
      collection_id: "collection-1",
      request: { fieldData: [{ name: "New draft", slug: "new-draft" }], isDraft: true }
    }
  });
});

test("finds an existing CMS item only on an exact slug match", () => {
  const response = { result: { items: [{ id: "item-1", fieldData: { name: "Post", slug: "the-shift-toward-open-weight-ai-models" } }] } };

  assert.equal(findItemWithSlug(response, "the-shift-toward-open-weight-ai-models"), "item-1");
  assert.equal(findItemWithSlug(response, "the-shift-toward-open-weight-ai-model"), undefined);
  assert.equal(findItemWithSlug({ result: { items: [] } }, "any-slug"), undefined);
});

test("requires a complete secure configuration before creating a Webflow OAuth link", () => {
  const connection = new WebflowMcpConnection({
    mcpUrl: "https://mcp.webflow.com/mcp",
    publicBaseUrl: "",
    statePath: ":memory:",
    tokenEncryptionKey: ""
  });

  assert.equal(connection.status().state, "configuration_missing");
  assert.ok("error" in connection.createConnectionLink());
});

test("reports an invalid Webflow encryption key as configuration missing", () => {
  const connection = new WebflowMcpConnection({
    mcpUrl: "https://mcp.webflow.com/mcp",
    publicBaseUrl: "https://slackflow-demo.onrender.com",
    statePath: ":memory:",
    tokenEncryptionKey: "not-a-32-byte-key"
  });

  const status = connection.status();
  assert.equal(status.state, "configuration_missing");
  if (status.state === "configuration_missing") {
    assert.match(status.message, /32-byte key/);
  }
});

function connectedConnection(): { connection: WebflowMcpConnection; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "slackflow-test-"));
  const statePath = join(directory, "state.sqlite");
  // A connection is "connected" once its encrypted store holds OAuth material.
  const store = new WebflowConnectionStore(statePath, encryptionKey);
  store.set("connection", "metadata", { connectedAt: Date.now() });
  store.set("connection", "tokens", { access_token: "test-token" });
  store.close();

  return {
    connection: new WebflowMcpConnection({
      mcpUrl: "https://mcp.webflow.com/mcp",
      publicBaseUrl: "https://slackflow-demo.onrender.com",
      statePath,
      tokenEncryptionKey: encryptionKey
    }),
    cleanup: () => rmSync(directory, { force: true, recursive: true })
  };
}

function pendingDraft(overrides: Partial<PendingWebflowDraft> = {}): PendingWebflowDraft {
  return {
    channel: "C123",
    contract: { collectionId: "collection-1", schemaFingerprint: "fingerprint" } as PendingWebflowDraft["contract"],
    expiresAt: Date.now() + 60_000,
    images: {
      banner: { altText: "Banner", file: Buffer.from([1, 2, 3]), filename: "banner.jpg", mimeType: "image/jpeg" },
      thumbnail: { altText: "Thumbnail", file: Buffer.from([4, 5, 6]), filename: "thumbnail.jpg", mimeType: "image/jpeg" }
    },
    mapping: { collectionId: "collection-1", fieldData: { name: "Post", slug: "post" }, imageFieldSlugs: {}, schemaFingerprint: "fingerprint" },
    proposal: { status: "ready" } as PendingWebflowDraft["proposal"],
    rootTs: "1700000000.000100",
    siteId: "site-1",
    siteShortName: "datasaur",
    ...overrides
  };
}

test("keeps an approved review readable from durable state", () => {
  const { connection, cleanup } = connectedConnection();
  connection.savePendingDraft("draft-1", pendingDraft());

  const restored = connection.getPendingDraft("draft-1");
  assert.equal(restored?.siteShortName, "datasaur");
  assert.deepEqual(restored?.images.thumbnail.file, Buffer.from([4, 5, 6]));
  cleanup();
});

test("drops a pending review once it expires, and on request", () => {
  const { connection, cleanup } = connectedConnection();
  connection.savePendingDraft("expired", pendingDraft({ expiresAt: Date.now() - 1 }));
  connection.savePendingDraft("live", pendingDraft());

  assert.equal(connection.getPendingDraft("expired"), undefined);
  assert.ok(connection.getPendingDraft("live"));
  connection.deletePendingDraft("live");
  assert.equal(connection.getPendingDraft("live"), undefined);
  cleanup();
});

test("disconnecting removes every pending review with the connection", () => {
  const { connection, cleanup } = connectedConnection();
  connection.savePendingDraft("draft-1", pendingDraft());
  connection.disconnect();

  assert.equal(connection.getPendingDraft("draft-1"), undefined);
  assert.equal(connection.status().state, "not_connected");
  cleanup();
});

test("creates a short-lived HTTPS Webflow OAuth start link", () => {
  const connection = new WebflowMcpConnection({
    mcpUrl: "https://mcp.webflow.com/mcp",
    publicBaseUrl: "https://slackflow-demo.onrender.com",
    statePath: ":memory:",
    tokenEncryptionKey: encryptionKey
  });
  const result = connection.createConnectionLink();

  assert.ok("link" in result);
  if ("link" in result) {
    const link = new URL(result.link);
    assert.equal(link.origin, "https://slackflow-demo.onrender.com");
    assert.equal(link.pathname, "/webflow/connect");
    assert.ok(link.searchParams.get("request"));
  }
});
