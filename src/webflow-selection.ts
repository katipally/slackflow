/** Slack allows at most 100 options in one static select menu. */
const WEBFLOW_CHOICE_LIMIT = 100;

export type WebflowSiteChoice = { id: string; label: string; shortName?: string };
export type WebflowCollectionChoice = { id: string; label: string };
export type WebflowChoiceList<T> = { choices: T[]; total: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function label(record: Record<string, unknown>): string | undefined {
  return text(record.displayName) ?? text(record.name) ?? text(record.shortName) ?? text(record.slug);
}

/** Finds the response's own `sites`/`collections` array before falling back to a blind crawl. */
function namedEntries(value: unknown, key: "sites" | "collections"): { entries: Record<string, unknown>[]; total: number } | undefined {
  const seen = new Set<unknown>();
  const visit = (item: unknown): { entries: Record<string, unknown>[]; total: number } | undefined => {
    if (!item || typeof item !== "object" || seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      const entries = candidate.filter((entry): entry is Record<string, unknown> => isRecord(entry) && Boolean(text(entry.id)) && Boolean(label(entry)));
      if (entries.length > 0) {
        const reported = isRecord(record.pagination) ? record.pagination.total : undefined;
        return { entries, total: typeof reported === "number" && reported >= entries.length ? reported : entries.length };
      }
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

/** Last resort for an unexpected response shape: any object carrying an id and a name. */
function crawledEntries(value: unknown): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const seen = new Set<unknown>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) return void item.forEach(visit);
    const record = item as Record<string, unknown>;
    const id = text(record.id);
    if (id && label(record) && !byId.has(id)) byId.set(id, record);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...byId.values()];
}

function entriesFor(data: unknown, key: "sites" | "collections"): { entries: Record<string, unknown>[]; total: number } {
  const named = namedEntries(data, key);
  if (named) return named;
  const crawled = crawledEntries(data);
  return { entries: crawled, total: crawled.length };
}

export function webflowSitesFromData(data: unknown): WebflowChoiceList<WebflowSiteChoice> {
  const { entries, total } = entriesFor(data, "sites");
  return {
    choices: entries.slice(0, WEBFLOW_CHOICE_LIMIT).map((entry) => ({
      id: text(entry.id) ?? "",
      label: label(entry) ?? "",
      shortName: text(entry.shortName)
    })),
    total
  };
}

export function webflowCollectionsFromData(data: unknown): WebflowChoiceList<WebflowCollectionChoice> {
  const { entries, total } = entriesFor(data, "collections");
  return {
    choices: entries.slice(0, WEBFLOW_CHOICE_LIMIT).map((entry) => ({ id: text(entry.id) ?? "", label: label(entry) ?? "" })),
    total
  };
}

/** Tells the reader when Webflow returned more than one Slack menu can hold. */
export function truncationNote(shown: number, total: number, noun: string): string {
  return total > shown ? `\nShowing the first ${shown} of ${total} ${noun}. Narrow the list in Webflow if the one you need is missing.` : "";
}
