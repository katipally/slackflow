import type { DraftProposal } from "./llm/contracts.js";
import { createExtractivePostSummary } from "./webflow-draft.js";

function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function displayValue(value: string | null, fallback = "Not provided"): string {
  return value && value.trim() ? value.trim() : fallback;
}

function slugFromTitle(title: string | null): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "Not available";
}

/** Formats a reviewable proposal only. It never creates or updates a CMS item. */
export function formatProposalPreview(proposal: DraftProposal, messageCount: number): string {
  const lines = [
    ":mag: *Slackflow draft proposal — no Webflow changes made*",
    `• ${messageCount} source messages read`,
    "*Fields with values*",
    `• Name: ${escapeSlackText(displayValue(proposal.fields.title))}`,
    `• Slug: ${escapeSlackText(slugFromTitle(proposal.fields.title))}`,
    "• Post Body: attached Markdown file",
    `• Publication Date: ${escapeSlackText(displayValue(proposal.fields.publication_date))}`,
    `• Source URL: ${escapeSlackText(displayValue(proposal.fields.source_url))}`,
    `• Tag: ${escapeSlackText(displayValue(proposal.fields.tag, "Leave blank"))}`,
    `• Post Summary: ${proposal.fields.body_markdown ? escapeSlackText(createExtractivePostSummary(proposal.fields.body_markdown)) : "Not available"}`,
    "• Main Image: attached 1920x1080 Blog Image",
    "• Thumbnail Image: same attached Blog Image when the selected schema validates it",
    "• Writer: Datasaur",
    "*Left blank or collection default*",
    "• Featured?, Color, Writer Profile Image, Category, Slide Show Popup, Created On (Inputted)",
    "The Markdown file contains the full body and the value for every field above."
  ];

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

  lines.push("Webflow creation stays unavailable until the selected CMS schema is read and its real fields are validated.");
  return lines.join("\n");
}
