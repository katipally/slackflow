import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiImageProvider } from "./openai-image-provider.js";

test("uses the native GPT Image 2 generation endpoint with the documented landscape output", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;

  const provider = new OpenAiImageProvider({
    apiKey: "test-key",
    model: "gpt-image-2",
    quality: "medium",
    outputFormat: "jpeg",
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ b64_json: "base64-image" }] }), {
        status: 200,
        headers: { "x-request-id": "req_image_test" }
      });
    }
  });

  const image = await provider.generateImage({ prompt: "A precise visual metaphor", size: "1536x1024" });

  assert.equal(requestUrl, "https://api.openai.com/v1/images/generations");
  assert.deepEqual(requestBody, {
    model: "gpt-image-2",
    prompt: "A precise visual metaphor",
    size: "1536x1024",
    quality: "medium",
    output_format: "jpeg",
    moderation: "auto"
  });
  assert.equal(image.base64Data, "base64-image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.providerRequestId, "req_image_test");
});

test("rejects an invalid GPT Image 2 size before making a request", async () => {
  await assert.rejects(
    new OpenAiImageProvider({
        apiKey: "test-key",
        model: "gpt-image-2",
        quality: "medium",
        outputFormat: "png"
      }).generateImage({ prompt: "A precise visual metaphor", size: "2048x1152" }),
    /outside the supported GPT Image 2 constraints/
  );
});
