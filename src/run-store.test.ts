import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SlackflowRunStore } from "./run-store.js";

test("claims a Slack command once across store restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slackflow-runs-"));
  const statePath = join(directory, "runs.sqlite");

  try {
    const firstStore = new SlackflowRunStore(statePath);
    assert.equal(firstStore.claim("Ev123", "T1:C1:1710000000.000000"), true);
    assert.equal(firstStore.claim("Ev123", "T1:C1:1710000000.000000"), false);
    firstStore.mark("Ev123", "completed");
    firstStore.close();

    const restartedStore = new SlackflowRunStore(statePath);
    assert.equal(restartedStore.claim("Ev123", "T1:C1:1710000000.000000"), false);
    assert.equal(restartedStore.claim("Ev456", "T1:C1:1710000000.000000"), false);
    assert.equal(restartedStore.claim("Ev789", "T1:C1:1710000001.000000"), true);
    restartedStore.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
