import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SlackflowRunStatus =
  | "claimed"
  | "blocked"
  | "draft_ready"
  | "image_generated"
  | "image_generation_failed"
  | "image_upload_failed"
  | "completed"
  | "failed";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A deliberately small, durable idempotency ledger. It stores only delivery
 * identifiers and lifecycle state—never Slack source content or credentials.
 */
export class SlackflowRunStore {
  private readonly database: DatabaseSync;

  constructor(statePath: string) {
    if (statePath !== ":memory:") {
      mkdirSync(dirname(statePath), { recursive: true });
    }

    this.database = new DatabaseSync(statePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS slackflow_runs (
        event_id TEXT PRIMARY KEY,
        command_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS slackflow_runs_created_at ON slackflow_runs(created_at);
    `);
  }

  /** Returns false for a duplicate delivery or the same command message. */
  claim(eventId: string, commandKey: string): boolean {
    const now = Date.now();
    this.database.prepare("DELETE FROM slackflow_runs WHERE created_at < ?").run(now - RETENTION_MS);
    const result = this.database
      .prepare("INSERT OR IGNORE INTO slackflow_runs (event_id, command_key, status, created_at, updated_at) VALUES (?, ?, 'claimed', ?, ?)")
      .run(eventId, commandKey, now, now);

    return result.changes === 1;
  }

  mark(eventId: string, status: SlackflowRunStatus): void {
    this.database.prepare("UPDATE slackflow_runs SET status = ?, updated_at = ? WHERE event_id = ?").run(status, Date.now(), eventId);
  }

  close(): void {
    this.database.close();
  }
}
