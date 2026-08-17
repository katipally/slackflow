import { createHash } from "node:crypto";

import type { DraftProposal, WebflowTag } from "./llm/contracts.js";

export const DEFAULT_WEBFLOW_WRITER = "Datasaur";

export type WebflowDraftMapping = {
  collectionId: string;
  fieldData: Record<string, unknown>;
  filledFields: Array<{ label: string; value: string }>;
  imageFieldSlugs: string[];
  schemaFingerprint: string;
};

/** A serializable, checked contract between this CMS schema and Slackflow's fixed writer. */
export type WebflowDraftContract = {
  approvedBlankFields: string[];
  body: { slug: string; type: string };
  collectionId: string;
  imageFieldSlugs: string[];
  schemaFingerprint: string;
  tag: { optionIds: Partial<Record<WebflowTag, string>>; slug: string };
  version: 1;
  writer: { slug: string; value: typeof DEFAULT_WEBFLOW_WRITER };
};

type SchemaField = {
  displayName: string;
  isRequired: boolean;
  options: Array<{ id: string; name: string }>;
  slug: string;
  type: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function optionValues(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = text(item.id);
    const name = text(item.name) ?? text(item.displayName);
    return id && name ? [{ id, name }] : [];
  });
}

function asSchemaField(value: unknown): SchemaField | undefined {
  if (!isRecord(value)) return undefined;
  const slug = text(value.slug);
  const type = text(value.type);
  const displayName = text(value.displayName) ?? text(value.name) ?? slug;
  if (!slug || !type || !displayName) return undefined;

  const validations = isRecord(value.validations) ? value.validations : undefined;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    displayName,
    isRequired: value.isRequired === true || value.required === true,
    options: optionValues(value.options).concat(optionValues(validations?.options), optionValues(metadata?.options)),
    slug,
    type
  };
}

/** Selects the largest real `fields` array in the MCP response. */
function extractSchemaFields(schema: unknown): SchemaField[] {
  const candidates: SchemaField[][] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.fields)) {
      const fields = record.fields.flatMap((field) => {
        const parsed = asSchemaField(field);
        return parsed ? [parsed] : [];
      });
      if (fields.length > 0) candidates.push(fields);
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return candidates.sort((left, right) => right.length - left.length)[0] ?? [];
}

/** Fingerprints only write-relevant schema data so field-order changes do not affect it. */
export function schemaFingerprint(schema: unknown): string {
  const source = extractSchemaFields(schema)
    .map((field) => ({
      displayName: field.displayName,
      isRequired: field.isRequired,
      options: field.options.slice().sort((left, right) => left.id.localeCompare(right.id)),
      slug: field.slug,
      type: field.type
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function findField(fields: SchemaField[], label: string): SchemaField | undefined {
  const wanted = normalize(label);
  return fields.find((field) => normalize(field.displayName) === wanted || normalize(field.slug) === wanted);
}

function requireField(fields: SchemaField[], label: string): SchemaField {
  const field = findField(fields, label);
  if (!field) throw new Error(`The selected CMS schema does not contain the required ${label} field.`);
  return field;
}

function requireOneOf(field: SchemaField, allowed: string[], label: string): void {
  if (!allowed.map(normalize).includes(normalize(field.type))) {
    throw new Error(`The ${label} field has unsupported type ${field.type}.`);
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Webflow Rich Text stores HTML. This is a deterministic formatting conversion,
 * not content generation: every text character comes from the reviewed source.
 */
export function markdownToWebflowHtml(markdown: string): string {
  return markdown
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export function slugFromTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("The exact title cannot produce a Webflow slug.");
  return slug;
}

/** Builds a fixed contract and stops whenever the selected collection is not safe to write. */
export function createWebflowDraftContract(input: {
  collectionId: string;
  schema: unknown;
}): WebflowDraftContract {
  const { collectionId, schema } = input;
  const fields = extractSchemaFields(schema);
  if (fields.length === 0) throw new Error("Slackflow could not validate fields from the captured CMS schema.");
  const bodyField = requireField(fields, "Post Body");
  const writerField = requireField(fields, "Writer");
  const tagField = requireField(fields, "Tag");
  const mainImageField = findField(fields, "Main Image");
  const thumbnailImageField = findField(fields, "Thumbnail Image");
  requireOneOf(bodyField, ["RichText", "PlainText"], "Post Body");
  requireOneOf(writerField, ["PlainText"], "Writer");
  requireOneOf(tagField, ["Option"], "Tag");
  for (const field of [mainImageField, thumbnailImageField]) {
    if (field) requireOneOf(field, ["Image", "ImageRef"], field.displayName);
  }

  const knownRequired = new Set(["postbody", "writer", "tag", "mainimage", "thumbnailimage", "name", "slug"]);
  const unexpectedRequired = fields.filter((field) => field.isRequired && !knownRequired.has(normalize(field.displayName)) && !knownRequired.has(normalize(field.slug)));
  if (unexpectedRequired.length > 0) {
    throw new Error(`The selected CMS schema has required field(s) Slackflow will not guess: ${unexpectedRequired.map((field) => field.displayName).join(", ")}.`);
  }

  const optionIds: Partial<Record<WebflowTag, string>> = {};
  for (const option of tagField.options) {
    if (option.name === "NLP Labeling" || option.name === "Labeling" || option.name === "AI Industry" || option.name === "Datasaur") {
      optionIds[option.name] = option.id;
    }
  }
  if (Object.keys(optionIds).length === 0) throw new Error("The selected CMS Tag field has none of Slackflow's verified tag options.");

  return {
    approvedBlankFields: ["Post Summary", "Featured?", "Color", "Writer Profile Image", "Category", "Slide Show Popup", "Created On (Inputted)"],
    body: { slug: bodyField.slug, type: bodyField.type },
    collectionId,
    imageFieldSlugs: [mainImageField, thumbnailImageField].flatMap((field) => field ? [field.slug] : []),
    schemaFingerprint: schemaFingerprint(schema),
    tag: { optionIds, slug: tagField.slug },
    version: 1,
    writer: { slug: writerField.slug, value: DEFAULT_WEBFLOW_WRITER }
  };
}

export function assertSchemaMatchesContract(schema: unknown, contract: WebflowDraftContract): void {
  if (schemaFingerprint(schema) !== contract.schemaFingerprint) {
    throw new Error("The Webflow CMS schema changed after Slackflow captured its contract. Run @slackflow schema again before creating a draft.");
  }
}

/** Maps one reviewed proposal through a previously captured contract. */
export function createWebflowDraftMapping(input: {
  contract: WebflowDraftContract;
  proposal: DraftProposal;
}): WebflowDraftMapping {
  const { contract, proposal } = input;
  const title = proposal.fields.title;
  const body = proposal.fields.body_markdown;
  const tag = proposal.fields.tag;
  if (!title || !body || !tag) throw new Error("The reviewed proposal is missing a required title, body, or tag.");
  const tagOptionId = contract.tag.optionIds[tag];
  if (!tagOptionId) throw new Error(`The selected CMS contract does not allow the Tag value ${tag}.`);

  const slug = slugFromTitle(title);
  const bodyValue = normalize(contract.body.type) === normalize("RichText") ? markdownToWebflowHtml(body) : body;
  return {
    collectionId: contract.collectionId,
    fieldData: {
      name: title,
      slug,
      [contract.body.slug]: bodyValue,
      [contract.writer.slug]: contract.writer.value,
      [contract.tag.slug]: tagOptionId
    },
    filledFields: [
      { label: "Name", value: title },
      { label: "Slug", value: slug },
      { label: "Post Body", value: "Attached strict-transfer Markdown body" },
      { label: "Writer", value: DEFAULT_WEBFLOW_WRITER },
      { label: "Tag", value: tag }
    ],
    imageFieldSlugs: contract.imageFieldSlugs,
    schemaFingerprint: contract.schemaFingerprint
  };
}

/** Applies the one already-reviewed asset to every verified CMS image field. */
export function applyWebflowImageToDraft(mapping: WebflowDraftMapping, asset: { id: string; url?: string; altText: string }): Record<string, unknown> {
  if (mapping.imageFieldSlugs.length === 0) return mapping.fieldData;
  if (!asset.url) throw new Error("Webflow did not return a hosted URL for the uploaded image asset.");
  const imageValue = { alt: asset.altText, fileId: asset.id, url: asset.url };
  return Object.fromEntries([
    ...Object.entries(mapping.fieldData),
    ...mapping.imageFieldSlugs.map((slug) => [slug, imageValue])
  ]);
}
