import assert from "node:assert/strict";
import test from "node:test";

import { parseSlackflowCommand } from "./slack-command.js";

test("accepts only the compact Slackflow draft command", () => {
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> draft"), "draft");
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> create a Webflow draft"), null);
  assert.equal(parseSlackflowCommand("<@U_SLACKFLOW> img"), null);
});
