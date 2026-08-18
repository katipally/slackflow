import { createHash } from "node:crypto";

import type { DraftProposal, WebflowTag } from "./llm/contracts.js";

export const DEFAULT_WEBFLOW_WRITER = "Datasaur";

export type WebflowDraftMapping = {
  collectionId: string;
  fieldData: Record<string, unknown>;
  imageFieldSlugs: { main?: string; thumbnail?: string };
  schemaFingerprint: string;
};

/** A serializable, checked contract between this CMS schema and Slackflow's fixed writer. */
export type WebflowDraftContract = {
  approvedBlankFields: string[];
  body: { slug: string; type: string };
  category?: { itemIds: Partial<Record<WebflowTag, string>>; slug: string; type: string };
  collectionId: string;
  images: { main?: { slug: string }; thumbnail?: { slug: string } };
  publicationDate?: { isRequired: boolean; slug: string; type: string };
  schemaFingerprint: string;
  summary?: { slug: string; type: string };
  sourceUrl?: { isRequired: boolean; slug: string; type: string };
  tag: { optionIds: Partial<Record<WebflowTag, string>>; slug: string };
  version: 2;
  writer: { slug: string; value: typeof DEFAULT_WEBFLOW_WRITER };
};

type SchemaField = {
  displayName: string;
  isRequired: boolean;
  options: Array<{ id: string; name: string }>;
  referenceCollectionId?: string;
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
    referenceCollectionId: text(metadata?.collectionId) ?? text(validations?.collectionId),
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
      referenceCollectionId: field.referenceCollectionId,
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

/** Returns the Category reference collection only when the selected schema exposes one. */
export function categoryReferenceCollectionId(schema: unknown): string | undefined {
  return findField(extractSchemaFields(schema), "Category")?.referenceCollectionId;
}

/** Extracts only exact, pre-existing category labels that match an allowed Tag. */
export function verifiedCategoryItemIds(data: unknown): Partial<Record<WebflowTag, string>> {
  const allowed = new Set<WebflowTag>(["NLP Labeling", "Labeling", "AI Industry", "Datasaur"]);
  const result: Partial<Record<WebflowTag, string>> = {};
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return void value.forEach(visit);
    const record = value as Record<string, unknown>;
    const id = text(record.id);
    const fieldData = isRecord(record.fieldData) ? record.fieldData : record;
    const name = text(fieldData.name) ?? text(fieldData["displayName"]);
    if (id && name && allowed.has(name as WebflowTag)) result[name as WebflowTag] = id;
    Object.values(record).forEach(visit);
  };
  visit(data);
  return result;
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

function validatePublicationDate(field: { isRequired: boolean; type: string }, value: string | null): string | undefined {
  const source = text(value);
  if (!source) return undefined;
  const type = normalize(field.type);
  if (type === normalize("PlainText")) return source;
  if (type === normalize("Date") && /^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
  if ((type === normalize("Date/Time") || type === normalize("DateTime")) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(source) && !Number.isNaN(Date.parse(source))) {
    return source;
  }
  if (!field.isRequired) return undefined;
  throw new Error(`The reviewed publication date is not valid for the required Webflow ${field.type} field. Slackflow will not invent a time or transform the source value.`);
}

function validateSourceUrl(field: { type: string }, value: string | null): string | undefined {
  const source = text(value);
  if (!source) return undefined;
  if (normalize(field.type) !== normalize("Link")) return source;
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") return source;
  } catch {
    // Fall through to the strict error below.
  }
  throw new Error(`The reviewed source URL is not valid for the Webflow ${field.type} field. Slackflow will not rewrite the exact source value.`);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function inlineMarkdown(value: string): string {
  let html = escapeHtml(value);
  const codeSpans: string[] = [];
  html = html.replaceAll(/`([^`]+)`/g, (_match, code: string) => {
    const token = `\u0000${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  html = html.replaceAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replaceAll(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replaceAll(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replaceAll(/\*([^*]+)\*/g, "<em>$1</em>").replaceAll(/_([^_]+)_/g, "<em>$1</em>");
  return html.replaceAll(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
}

/**
 * Webflow Rich Text stores HTML. This is a deterministic formatting conversion,
 * not content generation: every text character comes from the reviewed source.
 */
export function markdownToWebflowHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim().split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listType: "ol" | "ul" | undefined;
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!listType) return;
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${listType}>`);
    listType = undefined;
    listItems = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const italicHeading = line.match(/^\s*(?:\*([^*]+)\*|_([^_]+)_)\s*$/);
    if (heading || italicHeading) {
      flushParagraph();
      flushList();
      if (heading) {
        const marks = heading[1] ?? "";
        const headingText = heading[2] ?? "";
        blocks.push(`<h${marks.length}>${inlineMarkdown(headingText)}</h${marks.length}>`);
      } else {
        // A standalone italic source line is an existing editorial heading signal.
        // Convert only that signal to H2; do not infer headings from normal prose.
        blocks.push(`<h2>${inlineMarkdown(italicHeading?.[1] ?? italicHeading?.[2] ?? "")}</h2>`);
      }
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered ?? ordered)?.[1] ?? "");
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.join("");
}

export function slugFromTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("The exact title cannot produce a Webflow slug.");
  return slug;
}

/**
 * An extractive CMS summary. It only copies the opening source sentence(s),
 * so Slackflow never invents a summary that was not in the reviewed body.
 */
export function createExtractivePostSummary(body: string): string {
  const source = body.replace(/\s+/g, " ").trim();
  if (!source) throw new Error("Cannot create a post summary without a reviewed post body.");

  const sentences = source.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  const candidate = sentences.slice(0, 2).join("").trim() || source;
  if (candidate.length <= 320) return candidate;

  const shortened = candidate.slice(0, 320);
  return shortened.slice(0, Math.max(shortened.lastIndexOf(" "), 1)).trim();
}

/** Builds a fixed contract and stops whenever the selected collection is not safe to write. */
export function createWebflowDraftContract(input: {
  collectionId: string;
  categoryItemIds?: Partial<Record<WebflowTag, string>>;
  schema: unknown;
}): WebflowDraftContract {
  const { collectionId, schema } = input;
  const fields = extractSchemaFields(schema);
  if (fields.length === 0) throw new Error("Slackflow could not validate fields from the captured CMS schema.");
  const bodyField = requireField(fields, "Post Body");
  const summaryField = findField(fields, "Post Summary");
  const writerField = requireField(fields, "Writer");
  const tagField = requireField(fields, "Tag");
  const categoryField = findField(fields, "Category");
  const mainImageField = findField(fields, "Main Image");
  const thumbnailImageField = findField(fields, "Thumbnail Image");
  const publicationDateField = findField(fields, "Publication Date") ?? findField(fields, "Created On (Inputted)");
  const sourceUrlField = findField(fields, "Source URL");
  requireOneOf(bodyField, ["RichText", "PlainText"], "Post Body");
  if (summaryField) requireOneOf(summaryField, ["PlainText"], "Post Summary");
  requireOneOf(writerField, ["PlainText"], "Writer");
  requireOneOf(tagField, ["Option"], "Tag");
  if (categoryField) requireOneOf(categoryField, ["Reference", "MultiReference", "ItemRef"], "Category");
  if (publicationDateField) requireOneOf(publicationDateField, ["Date", "Date/Time", "DateTime", "PlainText"], publicationDateField.displayName);
  if (sourceUrlField) requireOneOf(sourceUrlField, ["Link", "PlainText"], sourceUrlField.displayName);
  for (const field of [mainImageField, thumbnailImageField]) {
    if (field) requireOneOf(field, ["Image", "ImageRef"], field.displayName);
  }

  const knownRequired = new Set(["postbody", "postsummary", "writer", "tag", "category", "mainimage", "thumbnailimage", "publicationdate", "createdoninputted", "sourceurl", "name", "slug"]);
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

  const mappedOptionalLabels = new Set([publicationDateField?.displayName, sourceUrlField?.displayName].filter((value): value is string => Boolean(value)).map(normalize));
  return {
    approvedBlankFields: ["Featured?", "Color", "Writer Profile Image", "Category", "Slide Show Popup", "Created On (Inputted)"]
      .filter((label) => !mappedOptionalLabels.has(normalize(label))),
    body: { slug: bodyField.slug, type: bodyField.type },
    category: categoryField ? { itemIds: input.categoryItemIds ?? {}, slug: categoryField.slug, type: categoryField.type } : undefined,
    collectionId,
    images: {
      ...(mainImageField ? { main: { slug: mainImageField.slug } } : {}),
      ...(thumbnailImageField ? { thumbnail: { slug: thumbnailImageField.slug } } : {})
    },
    publicationDate: publicationDateField ? { isRequired: publicationDateField.isRequired, slug: publicationDateField.slug, type: publicationDateField.type } : undefined,
    schemaFingerprint: schemaFingerprint(schema),
    summary: summaryField ? { slug: summaryField.slug, type: summaryField.type } : undefined,
    sourceUrl: sourceUrlField ? { isRequired: sourceUrlField.isRequired, slug: sourceUrlField.slug, type: sourceUrlField.type } : undefined,
    tag: { optionIds, slug: tagField.slug },
    version: 2,
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
  const categoryItemId = contract.category?.itemIds[tag];
  if (contract.category?.type && contract.category.itemIds && Object.keys(contract.category.itemIds).length > 0 && !categoryItemId) {
    throw new Error(`The selected CMS Category field has no verified item for ${tag}.`);
  }
  if (contract.category?.type && !categoryItemId && contract.category && Object.keys(contract.category.itemIds).length === 0) {
    throw new Error("Slackflow could not verify any compatible Category items. Run @slackflow schema again.");
  }

  const slug = slugFromTitle(title);
  const bodyValue = normalize(contract.body.type) === normalize("RichText") ? markdownToWebflowHtml(body) : body;
  const summary = contract.summary ? createExtractivePostSummary(body) : undefined;
  const publicationDate = contract.publicationDate ? validatePublicationDate(contract.publicationDate, proposal.fields.publication_date) : undefined;
  const sourceUrl = contract.sourceUrl ? validateSourceUrl(contract.sourceUrl, proposal.fields.source_url) : undefined;
  if (contract.publicationDate?.isRequired && !publicationDate) {
    throw new Error("The selected Webflow CMS requires a publication date, but the reviewed Slack thread did not provide one.");
  }
  if (contract.sourceUrl?.isRequired && !sourceUrl) {
    throw new Error("The selected Webflow CMS requires a source URL, but the reviewed Slack thread did not provide one.");
  }
  return {
    collectionId: contract.collectionId,
    fieldData: {
      name: title,
      slug,
      [contract.body.slug]: bodyValue,
      ...(contract.summary ? { [contract.summary.slug]: summary } : {}),
      ...(contract.publicationDate && publicationDate ? { [contract.publicationDate.slug]: publicationDate } : {}),
      [contract.writer.slug]: contract.writer.value,
      [contract.tag.slug]: tagOptionId,
      ...(contract.category && categoryItemId
        ? { [contract.category.slug]: normalize(contract.category.type) === normalize("MultiReference") ? [categoryItemId] : categoryItemId }
        : {}),
      ...(contract.sourceUrl && sourceUrl ? { [contract.sourceUrl.slug]: sourceUrl } : {})
    },
    imageFieldSlugs: {
      ...(contract.images.main ? { main: contract.images.main.slug } : {}),
      ...(contract.images.thumbnail ? { thumbnail: contract.images.thumbnail.slug } : {})
    },
    schemaFingerprint: contract.schemaFingerprint
  };
}

/** Maps the reviewed thumbnail and derived banner to their matching verified CMS fields. */
export function applyWebflowImagesToDraft(
  mapping: WebflowDraftMapping,
  assets: { main?: { id: string; url?: string; altText: string }; thumbnail?: { id: string; url?: string; altText: string } }
): Record<string, unknown> {
  const fieldData = { ...mapping.fieldData };
  for (const kind of ["main", "thumbnail"] as const) {
    const slug = mapping.imageFieldSlugs[kind];
    if (!slug) continue;
    const asset = assets[kind];
    if (!asset?.url) throw new Error(`Webflow did not return a hosted URL for the ${kind} image asset.`);
    fieldData[slug] = { alt: asset.altText, fileId: asset.id, url: asset.url };
  }
  return fieldData;
}
