export type GeneratedImage = {
  base64Data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  providerRequestId: string | null;
};

export type ImageGenerationProvider = {
  id: string;
  generateImage(input: { prompt: string; size: string }): Promise<GeneratedImage>;
};

export type ImageProviderConfig = {
  model: string;
  openaiApiKey?: string;
  outputFormat: "jpeg" | "png" | "webp";
  provider: string;
  quality: "low" | "medium" | "high" | "auto";
};
