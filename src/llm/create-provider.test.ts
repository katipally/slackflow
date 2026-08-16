import assert from "node:assert/strict";
import test from "node:test";

import { createDraftModelProvider } from "./create-provider.js";

test("selects the OpenAI adapter through the provider-neutral factory", () => {
  const provider = createDraftModelProvider({
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    openaiApiKey: "test-key"
  });

  assert.equal(provider.id, "openai");
});

test("does not pretend an unimplemented provider is available", () => {
  assert.throws(
    () =>
      createDraftModelProvider({
        provider: "anthropic",
        model: "claude-placeholder",
        reasoningEffort: "medium",
        anthropicApiKey: "test-key"
      }),
    /adapter has not been implemented/
  );
});
