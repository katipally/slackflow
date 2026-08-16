import type { DraftProposal, TransferSourceSegment } from "./llm/contracts.js";

const MAX_VISIBLE_BODY_SOURCES = 10;

function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function displayValue(value: string | null, fallback = "Not provided"): string {
  return value && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function previewValue(value: string | null, limit: number, fallback?: string): string {
  return escapeSlackText(truncate(displayValue(value, fallback), limit));
}

function sourceLine(label: string, source: TransferSourceSegment | null): string | null {
  return source ? `• ${label} ← ${source.message_timestamp}` : null;
}

/** Formats a reviewable proposal only. It never creates or updates a CMS item. */
export function formatProposalPreview(proposal: DraftProposal, messageCount: number): string {
  const lines = [
    ":mag: *Slackflow draft proposal — no Webflow changes made*",
    `• Thread context at invocation: ${messageCount} source messages`,
    `• Mode: ${proposal.mode}`,
    `• Status: *${proposal.status}*`,
    `• Title: ${previewValue(proposal.fields.title, 180)}`,
    `• Body preview: ${previewValue(proposal.fields.body_markdown, 600)}`,
    `• Publication date: ${previewValue(proposal.fields.publication_date, 80)}`,
    `• Source URL: ${previewValue(proposal.fields.source_url, 240)}`,
    `• Webflow Tag: ${previewValue(proposal.fields.tag, 80, "Needs classification")}`,
    `• Thumbnail brief: ${previewValue(proposal.fields.thumbnail_brief, 220)}`,
    `• Banner brief: ${previewValue(proposal.fields.banner_brief, 220)}`,
    `• Exact body source segments: ${proposal.source_selections.body_markdown.length}`
  ];

  const fieldSources = [
    sourceLine("Title source", proposal.source_selections.title),
    ...proposal.source_selections.body_markdown
      .slice(0, MAX_VISIBLE_BODY_SOURCES)
      .map((source, index) => `• Body source ${index + 1} ← ${source.message_timestamp}`),
    sourceLine("Publication date source", proposal.source_selections.publication_date),
    sourceLine("Source URL source", proposal.source_selections.source_url),
    sourceLine("Thumbnail brief source", proposal.source_selections.thumbnail_brief),
    sourceLine("Banner brief source", proposal.source_selections.banner_brief)
  ].filter((line): line is string => line !== null);

  if (fieldSources.length > 0) {
    lines.push("*Exact transfer sources (field ← Slack message timestamp)*", ...fieldSources);

    const hiddenSourceCount = proposal.source_selections.body_markdown.length - MAX_VISIBLE_BODY_SOURCES;
    if (hiddenSourceCount > 0) {
      lines.push(`• ${hiddenSourceCount} additional exact body source${hiddenSourceCount === 1 ? "" : "s"} omitted from this preview.`);
    }
  }

  if (proposal.tag_selection.selected_tag && proposal.tag_selection.reason) {
    lines.push(`• Tag rationale: ${escapeSlackText(truncate(proposal.tag_selection.reason, 180))} ← ${proposal.tag_selection.message_timestamps.join(", ")}`);
  }

  if (proposal.missing_fields.length > 0) {
    lines.push(`• Missing: ${proposal.missing_fields.map(escapeSlackText).join(", ")}`);
  }

  if (proposal.conflicts.length > 0) {
    lines.push("*Conflicts*");
    for (const conflict of proposal.conflicts) {
      lines.push(`• ${escapeSlackText(conflict.field)}: ${escapeSlackText(conflict.reason)} ← ${conflict.message_timestamps.join(", ")}`);
    }
  }

  if (proposal.explicitly_blank.length > 0) {
    lines.push(`• Explicitly blank: ${proposal.explicitly_blank.map(escapeSlackText).join(", ")}`);
  }

  lines.push("Webflow CMS mapping and creation remain disabled until Slackflow reads the approved collection schema.");
  return lines.join("\n");
}
