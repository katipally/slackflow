import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CIPHER = "aes-256-gcm";
const VERSION = "v1";

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error("WEBFLOW_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }

  return key;
}

/** Stores OAuth material encrypted at rest. It never logs or returns raw database values. */
export class WebflowConnectionStore {
  private readonly database: DatabaseSync;
  private readonly key: Buffer;

  constructor(statePath: string, tokenEncryptionKey: string) {
    if (statePath !== ":memory:") {
      mkdirSync(dirname(statePath), { recursive: true });
    }

    this.key = encryptionKey(tokenEncryptionKey);
    this.database = new DatabaseSync(statePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS webflow_connection_values (
        session_id TEXT NOT NULL,
        value_key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, value_key)
      ) STRICT;
    `);
  }

  get<T>(sessionId: string, valueKey: string): T | undefined {
    const row = this.database
      .prepare("SELECT encrypted_value FROM webflow_connection_values WHERE session_id = ? AND value_key = ?")
      .get(sessionId, valueKey) as { encrypted_value?: string } | undefined;

    return row?.encrypted_value ? this.decrypt<T>(row.encrypted_value) : undefined;
  }

  set(sessionId: string, valueKey: string, value: unknown): void {
    this.database
      .prepare(`
        INSERT INTO webflow_connection_values (session_id, value_key, encrypted_value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, value_key)
        DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at
      `)
      .run(sessionId, valueKey, this.encrypt(value), Date.now());
  }

  remove(sessionId: string, valueKey: string): void {
    this.database.prepare("DELETE FROM webflow_connection_values WHERE session_id = ? AND value_key = ?").run(sessionId, valueKey);
  }

  removeSession(sessionId: string): void {
    this.database.prepare("DELETE FROM webflow_connection_values WHERE session_id = ?").run(sessionId);
  }

  close(): void {
    this.database.close();
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  private decrypt<T>(storedValue: string): T {
    const [version, ivValue, tagValue, ciphertextValue] = storedValue.split(".");

    if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
      throw new Error("Stored Webflow OAuth data has an unsupported format.");
    }

    const decipher = createDecipheriv(CIPHER, this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]);

    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}
