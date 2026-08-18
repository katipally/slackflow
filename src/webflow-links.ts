const DESIGNER_ORIGIN = "https://webflow.com/design";

/**
 * Webflow's CMS create response carries no editor URL, so the Slack button
 * opens the Designer for the site that received the draft. A site short name
 * from another source is never trusted into a link without this shape check.
 */
export function webflowSiteDesignerUrl(shortName: string | undefined): string | undefined {
  const trimmed = shortName?.trim();
  if (!trimmed || !/^[a-z0-9-]+$/i.test(trimmed)) return undefined;
  return `${DESIGNER_ORIGIN}/${trimmed}`;
}
