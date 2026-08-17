import assert from "node:assert/strict";
import test from "node:test";

import { createWebflowDataToolRequest, WebflowMcpConnection, webflowS3FieldName } from "./webflow-mcp.js";

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
