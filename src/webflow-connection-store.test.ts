import assert from "node:assert/strict";
import test from "node:test";

import { WebflowConnectionStore } from "./webflow-connection-store.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

test("stores and removes Webflow OAuth values through the encrypted store", () => {
  const store = new WebflowConnectionStore(":memory:", encryptionKey);

  store.set("connection", "tokens", { access_token: "not-logged", refresh_token: "also-not-logged" });
  assert.deepEqual(store.get("connection", "tokens"), { access_token: "not-logged", refresh_token: "also-not-logged" });

  store.removeSession("connection");
  assert.equal(store.get("connection", "tokens"), undefined);
  store.close();
});

test("rejects an incorrectly sized Webflow encryption key", () => {
  assert.throws(() => new WebflowConnectionStore(":memory:", "too-short"), /32-byte key/);
});
