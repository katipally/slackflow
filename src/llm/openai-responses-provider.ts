import type { ThreadTranscript } from "../thread.js";
import {
  DRAFT_EXTRACTION_INSTRUCTIONS,
  DRAFT_PROPOSAL_SCHEMA,
  parseDraftProposal,
  serializeTranscript,
  type DraftGenerationResult
} from "./contracts.js";
import type { DraftModelProvider } from "./provider.js";

const REQUEST_TIMEOUT_MS = 120_000;

type OpenAiErrorPayload = {
  error?: { message?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractOutputText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error("OpenAI returned an unexpected Responses API payload.");
  }

  for (const outputItem of payload.output) {
    if (!isRecord(outputItem) || outputItem.type !== "message" || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (isRecord(contentItem) && contentItem.type === "output_text" && typeof contentItem.text === "string") {
        return contentItem.text;
      }
    }
  }

  throw new Error("OpenAI returned no output text for the draft proposal.");
}

export class OpenAiResponsesProvider implements DraftModelProvider {
  readonly id = "openai";

  constructor(
    private readonly options: {
      apiKey: string;
      fetchImplementation?: typeof fetch;
      model: string;
      reasoningEffort: string;
    }
  ) {
    const allowedReasoningEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

    if (!allowedReasoningEfforts.has(options.reasoningEffort)) {
      throw new Error(`Unsupported OpenAI reasoning effort: ${options.reasoningEffort}.`);
    }
  }

  async generateDraftProposal({ transcript }: { transcript: ThreadTranscript }): Promise<DraftGenerationResult> {
    const response = await (this.options.fetchImplementation ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.options.model,
        store: false,
        reasoning: { effort: this.options.reasoningEffort },
        instructions: DRAFT_EXTRACTION_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: serializeTranscript(transcript)
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "slackflow_draft_proposal",
            strict: true,
            schema: DRAFT_PROPOSAL_SCHEMA
          }
        }
      })
    });

    const payload: unknown = await response.json();

    if (!response.ok) {
      const errorPayload = payload as OpenAiErrorPayload;
      const message = errorPayload.error?.message;
      throw new Error(`OpenAI Responses API request failed (${response.status}): ${typeof message === "string" ? message : "Unknown error"}`);
    }

    const responseId = isRecord(payload) ? payload.id : undefined;

    if (typeof responseId !== "string") {
      throw new Error("OpenAI returned a response without an ID.");
    }

    return {
      providerResponseId: responseId,
      proposal: parseDraftProposal(extractOutputText(payload), transcript)
    };
  }
}
