import type { ThreadTranscript } from "../thread.js";
import type { DraftGenerationResult } from "./contracts.js";

export type DraftModelProvider = {
  id: string;
  generateDraftProposal(input: { transcript: ThreadTranscript }): Promise<DraftGenerationResult>;
};

export type LlmProviderConfig = {
  anthropicApiKey?: string;
  model: string;
  openaiApiKey?: string;
  provider: string;
  reasoningEffort: string;
};
