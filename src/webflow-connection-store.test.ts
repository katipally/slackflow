import assert from "node:assert/strict";
import test from "node:test";

import { WebflowConnectionStore } from "./webflow-connection-store.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function newStore(): WebflowConnectionStore {
  return new WebflowConnectionStore(":memory:", encryptionKey);
}

test("round-trips a stored value without exposing it in plain text", () => {
  const store = newStore();
  store.set("connection", "tokens", { access_token: "secret-value" });

  assert.deepEqual(store.get("connection", "tokens"), { access_token: "secret-value" });
  store.close();
});

test("rejects an incorrectly sized Webflow encryption key", () => {
  assert.throws(() => new WebflowConnectionStore(":memory:", "too-short"), /32-byte key/);
});

test("lists only the session ids matching a prefix", () => {
  const store = newStore();
  store.set("draft:one", "record", { expiresAt: 1 });
  store.set("draft:two", "record", { expiresAt: 2 });
  store.set("connection", "metadata", { connectedAt: 3 });

  assert.deepEqual(store.sessionIds("draft:").sort(), ["draft:one", "draft:two"]);
  assert.deepEqual(store.sessionIds("connection"), ["connection"]);
  store.close();
});

test("treats SQL wildcards in a prefix as literal characters", () => {
  const store = newStore();
  store.set("draft:one", "record", { expiresAt: 1 });

  assert.deepEqual(store.sessionIds("%"), []);
  assert.deepEqual(store.sessionIds("draft_"), []);
  store.close();
});

test("removes every value for one session", () => {
  const store = newStore();
  store.set("draft:one", "record", { expiresAt: 1 });
  store.removeSession("draft:one");

  assert.deepEqual(store.sessionIds("draft:"), []);
  assert.equal(store.get("draft:one", "record"), undefined);
  store.close();
});
