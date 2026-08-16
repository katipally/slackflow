import assert from "node:assert/strict";
import test from "node:test";

import { parseSlackflowCommand } from "./slack-command.js";

test("accepts only the compact Slackflow command set", () => {
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> draft"), "draft");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> help"), "help");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> status"), "status");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> connect"), "connect");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> schema"), "schema");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> disconnect"), "disconnect");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> create a Webflow draft"), null);
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> img"), null);
});
