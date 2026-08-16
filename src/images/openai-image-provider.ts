import type { GeneratedImage, ImageGenerationProvider } from "./provider.js";

type OpenAiErrorPayload = {
  error?: { code?: string; message?: string };
};

type ImageFormat = "jpeg" | "png" | "webp";
type ImageQuality = "low" | "medium" | "high" | "auto";

const REQUEST_TIMEOUT_MS = 120_000;

const MIME_TYPE_BY_OUTPUT_FORMAT: Record<ImageFormat, GeneratedImage["mimeType"]> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSize(size: string): void {
  if (!new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]).has(size)) {
    throw new Error(`Image size ${size} is outside the supported GPT Image 2 constraints.`);
  }
}

function extractBase64Image(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("OpenAI returned an unexpected Image API payload.");
  }

  const firstImage = payload.data[0];

  if (!isRecord(firstImage) || typeof firstImage.b64_json !== "string" || !firstImage.b64_json) {
    throw new Error("OpenAI returned no base64 image data.");
  }

  return firstImage.b64_json;
}

/** Native HTTP adapter; no OpenAI SDK is used. */
export class OpenAiImageProvider implements ImageGenerationProvider {
  readonly id = "openai";

  constructor(
    private readonly options: {
      apiKey: string;
      fetchImplementation?: typeof fetch;
      model: string;
      outputFormat: ImageFormat;
      quality: ImageQuality;
    }
  ) {
    if (!new Set<ImageQuality>(["low", "medium", "high", "auto"]).has(options.quality)) {
      throw new Error(`Unsupported OpenAI image quality: ${options.quality}.`);
    }
  }

  async generateImage(input: { prompt: string; size: string }): Promise<GeneratedImage> {
    if (!input.prompt.trim()) {
      throw new Error("Cannot generate an image from an empty prompt.");
    }

    validateSize(input.size);

    const response = await (this.options.fetchImplementation ?? fetch)("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.options.model,
        prompt: input.prompt,
        size: input.size,
        quality: this.options.quality,
        output_format: this.options.outputFormat,
        moderation: "auto"
      })
    });

    const payload: unknown = await response.json();

    if (!response.ok) {
      const errorPayload = payload as OpenAiErrorPayload;
      const code = errorPayload.error?.code;
      const message = errorPayload.error?.message;
      const prefix = code === "moderation_blocked" ? "OpenAI blocked image generation for safety" : "OpenAI Image API request failed";
      throw new Error(`${prefix} (${response.status}): ${typeof message === "string" ? message : "Unknown error"}`);
    }

    return {
      base64Data: extractBase64Image(payload),
      mimeType: MIME_TYPE_BY_OUTPUT_FORMAT[this.options.outputFormat],
      providerRequestId: response.headers.get("x-request-id")
    };
  }
}
