import { OpenAiImageProvider } from "./openai-image-provider.js";
import type { ImageGenerationProvider, ImageProviderConfig } from "./provider.js";

function requireProviderSecret(value: string | undefined, environmentVariable: string, provider: string): string {
  if (!value) {
    throw new Error(`IMAGE_PROVIDER=${provider} requires ${environmentVariable}.`);
  }

  return value;
}

/** Provider-neutral image-generation factory. Add future providers as native adapters. */
export function createImageGenerationProvider(config: ImageProviderConfig): ImageGenerationProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAiImageProvider({
        apiKey: requireProviderSecret(config.openaiApiKey, "OPENAI_API_KEY", "openai"),
        model: config.model,
        outputFormat: config.outputFormat,
        quality: config.quality
      });
    default:
      throw new Error(`Unsupported IMAGE_PROVIDER=${config.provider}. Add and test a provider adapter before selecting it.`);
  }
}
