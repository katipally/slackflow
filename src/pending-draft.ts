import { Buffer } from "node:buffer";

import type { GeneratedImagePreview } from "./image-preview.js";
import type { DraftProposal } from "./llm/contracts.js";
import type { WebflowDraftContract, WebflowDraftMapping } from "./webflow-draft.js";

type WebflowUploadedAssets = Partial<Record<"main" | "thumbnail", { id: string; url?: string }>>;

/** One reviewed proposal waiting for its explicit Create Webflow draft confirmation. */
export type PendingWebflowDraft = {
  channel: string;
  collectionName?: string;
  contract: WebflowDraftContract;
  expiresAt: number;
  images: GeneratedImagePreview["webflowImages"];
  mapping: WebflowDraftMapping;
  proposal: DraftProposal;
  rootTs: string;
  siteId: string;
  siteShortName?: string;
  uploadedAssets?: WebflowUploadedAssets;
};

type StoredImage = { altText: string; base64: string; filename: string; mimeType: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMimeType(value: unknown): value is GeneratedImagePreview["webflowImages"]["banner"]["mimeType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

/** SQLite state holds JSON, so image bytes travel as base64 and never as a lossy `Buffer` literal. */
export function serializePendingWebflowDraft(draft: PendingWebflowDraft): Record<string, unknown> {
  const storeImage = (image: GeneratedImagePreview["webflowImages"]["banner"]): StoredImage => ({
    altText: image.altText,
    base64: image.file.toString("base64"),
    filename: image.filename,
    mimeType: image.mimeType
  });

  return {
    ...draft,
    images: { banner: storeImage(draft.images.banner), thumbnail: storeImage(draft.images.thumbnail) }
  };
}

export function deserializePendingWebflowDraft(value: unknown): PendingWebflowDraft | undefined {
  if (!isRecord(value) || !isRecord(value.images)) return undefined;

  const readImage = (image: unknown): GeneratedImagePreview["webflowImages"]["banner"] | undefined => {
    if (!isRecord(image) || typeof image.base64 !== "string" || typeof image.altText !== "string") return undefined;
    if (typeof image.filename !== "string" || !isMimeType(image.mimeType)) return undefined;
    return { altText: image.altText, file: Buffer.from(image.base64, "base64"), filename: image.filename, mimeType: image.mimeType };
  };

  const banner = readImage(value.images.banner);
  const thumbnail = readImage(value.images.thumbnail);
  if (!banner || !thumbnail) return undefined;
  if (typeof value.channel !== "string" || typeof value.rootTs !== "string" || typeof value.expiresAt !== "number") return undefined;
  if (!isRecord(value.contract) || !isRecord(value.mapping) || !isRecord(value.proposal) || typeof value.siteId !== "string") return undefined;

  return { ...(value as unknown as PendingWebflowDraft), images: { banner, thumbnail } };
}
