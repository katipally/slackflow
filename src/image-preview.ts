import { Buffer } from "node:buffer";
import sharp from "sharp";

import { loadImagePrompt } from "./images/prompt.js";
import type { ImageGenerationProvider } from "./images/provider.js";
import type { DraftProposal } from "./llm/contracts.js";
import { createExtractivePostSummary } from "./webflow-draft.js";

export type SlackImageUpload = {
  alt_text: string;
  file: Buffer;
  filename: string;
  title: string;
};

export type GeneratedImagePreview = {
  fileUploads: SlackImageUpload[];
  providerRequestIds: Array<string | null>;
  /** A 16:9 thumbnail and an uncropped, black-canvas banner derived from it. */
  webflowImages: {
    banner: { altText: string; file: Buffer; filename: string; mimeType: "image/jpeg" | "image/png" | "image/webp" };
    thumbnail: { altText: string; file: Buffer; filename: string; mimeType: "image/jpeg" | "image/png" | "image/webp" };
  };
};

const BLOG_IMAGE_WIDTH = 1920;
const BLOG_IMAGE_HEIGHT = 1080;
const BANNER_IMAGE_HEIGHT = 640;

function filenameStem(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);

  return stem || "slackflow-draft";
}

function fileExtension(mimeType: "image/jpeg" | "image/png" | "image/webp"): "jpg" | "png" | "webp" {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

function renderDraftMarkdown(proposal: DraftProposal): string {
  if (!proposal.fields.title || !proposal.fields.body_markdown) {
    throw new Error("Cannot create a Markdown file without a reviewed title and body.");
  }

  const slug = filenameStem(proposal.fields.title);
  const value = (field: string | null, missing = "Leave blank. Not provided in the Slack thread.") => field?.trim() || missing;

  return [
    "# Slackflow Webflow draft",
    "",
    "## Field values",
    "",
    `- **Name:** ${proposal.fields.title}`,
    `- **Slug:** ${slug}`,
    `- **Publication Date:** ${value(proposal.fields.publication_date)}`,
    `- **Source URL:** ${value(proposal.fields.source_url)}`,
    `- **Tag:** ${value(proposal.fields.tag)}`,
    `- **Post Summary:** ${createExtractivePostSummary(proposal.fields.body_markdown)}`,
    "- **Main Image:** Attached banner derived from the reviewed Blog Image (1920x640).",
    "- **Thumbnail Image:** Attached Blog Image (1920x1080).",
    "- **Featured?:** Leave at the collection default.",
    "- **Color:** Leave blank.",
    "- **Writer:** Datasaur.",
    "- **Writer Profile Image:** Leave blank unless the selected CMS mapping has a verified default.",
    "- **Category:** Matching verified CMS Category item for the selected Tag, when the selected CMS schema has one.",
    "- **Slide Show Popup:** Leave blank.",
    "- **Created On (Inputted):** Leave blank.",
    "",
    "## Post Body",
    "",
    proposal.fields.body_markdown,
    ""
  ].join("\n");
}

/**
 * GPT Image 2's documented landscape source is 1536x1024, not 16:9. Preserve
 * every generated pixel by placing it on an opaque black 1920x1080 canvas;
 * the prompt's requested negative side space makes this a safe no-crop export.
 */
async function renderBlogImage(base64Data: string, mimeType: "image/jpeg" | "image/png" | "image/webp"): Promise<Buffer> {
  const image = sharp(Buffer.from(base64Data, "base64")).resize({
    width: BLOG_IMAGE_WIDTH,
    height: BLOG_IMAGE_HEIGHT,
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 1 }
  });

  switch (mimeType) {
    case "image/jpeg":
      return image.jpeg().toBuffer();
    case "image/png":
      return image.png().toBuffer();
    case "image/webp":
      return image.webp().toBuffer();
  }
}

/** Preserve every pixel of the reviewed thumbnail inside the site's wide banner canvas. */
async function renderBannerImage(thumbnail: Buffer, mimeType: "image/jpeg" | "image/png" | "image/webp"): Promise<Buffer> {
  const image = sharp(thumbnail).resize({
    width: BLOG_IMAGE_WIDTH,
    height: BANNER_IMAGE_HEIGHT,
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 1 }
  });
  switch (mimeType) {
    case "image/jpeg": return image.jpeg().toBuffer();
    case "image/png": return image.png().toBuffer();
    case "image/webp": return image.webp().toBuffer();
  }
}

/**
 * Creates the exact transferred draft and one review image. It cannot upload
 * to Webflow or create or publish a CMS item; the caller decides where to show the files.
 */
export async function generateSlackImagePreview(input: {
  imageProvider: ImageGenerationProvider;
  imageSize: string;
  proposal: DraftProposal;
}): Promise<GeneratedImagePreview> {
  const { proposal } = input;

  if (proposal.status !== "ready" || !proposal.fields.title || !proposal.fields.body_markdown) {
    throw new Error("Images can only be generated from a ready proposal with a reviewed title and body.");
  }

  const prompt = await loadImagePrompt({ title: proposal.fields.title, content: proposal.fields.body_markdown });
  const image = await input.imageProvider.generateImage({ prompt, size: input.imageSize });
  const thumbnail = await renderBlogImage(image.base64Data, image.mimeType);
  const banner = await renderBannerImage(thumbnail, image.mimeType);
  const stem = filenameStem(proposal.fields.title);
  const extension = fileExtension(image.mimeType);
  const thumbnailFilename = `${stem}-thumbnail.${extension}`;
  const bannerFilename = `${stem}-banner.${extension}`;

  return {
    fileUploads: [
      {
        alt_text: `Full strict-transfer Markdown draft for ${proposal.fields.title}`,
        file: Buffer.from(renderDraftMarkdown(proposal), "utf8"),
        filename: `${stem}-draft.md`,
        title: `${proposal.fields.title} — Strict-transfer Draft`
      },
      {
        alt_text: `Generated 1920 by 1080 blog thumbnail for ${proposal.fields.title}`,
        file: thumbnail,
        filename: thumbnailFilename,
        title: `${proposal.fields.title} — Thumbnail Image`
      },
      {
        alt_text: `Generated 1920 by 640 banner for ${proposal.fields.title}`,
        file: banner,
        filename: bannerFilename,
        title: `${proposal.fields.title} — Banner Image`
      }
    ],
    providerRequestIds: [image.providerRequestId],
    webflowImages: {
      banner: {
        altText: `Generated banner for ${proposal.fields.title}`,
        file: banner,
        filename: bannerFilename,
        mimeType: image.mimeType
      },
      thumbnail: {
        altText: `Generated thumbnail for ${proposal.fields.title}`,
        file: thumbnail,
        filename: thumbnailFilename,
        mimeType: image.mimeType
      }
    }
  };
}
