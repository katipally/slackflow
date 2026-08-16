import "dotenv/config";

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function configuredLlmProvider(): string {
  return process.env.LLM_PROVIDER?.trim().toLowerCase() || "openai";
}

function configuredImageProvider(): string {
  return process.env.IMAGE_PROVIDER?.trim().toLowerCase() || "openai";
}

function configuredImageQuality(): "low" | "medium" | "high" | "auto" {
  const quality = process.env.IMAGE_QUALITY?.trim().toLowerCase() || "medium";

  if (quality === "low" || quality === "medium" || quality === "high" || quality === "auto") {
    return quality;
  }

  throw new Error(`Unsupported IMAGE_QUALITY=${quality}.`);
}

function configuredImageOutputFormat(): "jpeg" | "png" | "webp" {
  const outputFormat = process.env.IMAGE_OUTPUT_FORMAT?.trim().toLowerCase() || "jpeg";

  if (outputFormat === "jpeg" || outputFormat === "png" || outputFormat === "webp") {
    return outputFormat;
  }

  throw new Error(`Unsupported IMAGE_OUTPUT_FORMAT=${outputFormat}.`);
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? "3000"),
  statePath: process.env.SLACKFLOW_STATE_PATH?.trim() || ".slackflow/state.sqlite",
  slack: {
    appToken: requiredEnvironmentValue("SLACK_APP_TOKEN"),
    botToken: requiredEnvironmentValue("SLACK_BOT_TOKEN"),
    signingSecret: requiredEnvironmentValue("SLACK_SIGNING_SECRET")
  },
  llm: {
    model: process.env.LLM_MODEL?.trim() || "gpt-5.6-luna",
    provider: configuredLlmProvider(),
    reasoningEffort: process.env.LLM_REASONING_EFFORT?.trim() || "medium",
    openaiApiKey: optionalEnvironmentValue("OPENAI_API_KEY"),
    anthropicApiKey: optionalEnvironmentValue("ANTHROPIC_API_KEY")
  },
  image: {
    model: process.env.IMAGE_MODEL?.trim() || "gpt-image-2",
    outputFormat: configuredImageOutputFormat(),
    provider: configuredImageProvider(),
    quality: configuredImageQuality(),
    blogImageSize: process.env.IMAGE_BLOG_SIZE?.trim() || "1536x1024",
    openaiApiKey: optionalEnvironmentValue("OPENAI_API_KEY")
  },
  webflow: {
    mcpUrl: process.env.WEBFLOW_MCP_URL?.trim() || "https://mcp.webflow.com/mcp",
    publicBaseUrl: optionalEnvironmentValue("PUBLIC_BASE_URL"),
    tokenEncryptionKey: optionalEnvironmentValue("WEBFLOW_TOKEN_ENCRYPTION_KEY")
  }
} as const;
