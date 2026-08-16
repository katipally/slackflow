import { OpenAiResponsesProvider } from "./openai-responses-provider.js";
import type { DraftModelProvider, LlmProviderConfig } from "./provider.js";

function requireProviderSecret(value: string | undefined, environmentVariable: string, provider: string): string {
  if (!value) {
    throw new Error(`LLM_PROVIDER=${provider} requires ${environmentVariable}.`);
  }

  return value;
}

export function createDraftModelProvider(config: LlmProviderConfig): DraftModelProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAiResponsesProvider({
        apiKey: requireProviderSecret(config.openaiApiKey, "OPENAI_API_KEY", "openai"),
        model: config.model,
        reasoningEffort: config.reasoningEffort
      });
    case "anthropic":
      requireProviderSecret(config.anthropicApiKey, "ANTHROPIC_API_KEY", "anthropic");
      throw new Error("The Anthropic adapter has not been implemented yet. Slackflow's provider-neutral contract is ready for it, but do not select LLM_PROVIDER=anthropic until the adapter is added and tested.");
    default:
      throw new Error(`Unsupported LLM_PROVIDER=${config.provider}. Add and test a provider adapter before selecting it.`);
  }
}
