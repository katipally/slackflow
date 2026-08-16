import assert from "node:assert/strict";
import test from "node:test";

import { createImageGenerationProvider } from "./create-provider.js";

test("selects the OpenAI image adapter through the provider-neutral factory", () => {
  const provider = createImageGenerationProvider({
    provider: "openai",
    model: "gpt-image-2",
    quality: "medium",
    outputFormat: "jpeg",
    openaiApiKey: "test-key"
  });

  assert.equal(provider.id, "openai");
});
