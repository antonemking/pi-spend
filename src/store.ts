/**
 * SQLite storage for spend events. node:sqlite, zero dependencies.
 * Works on Node >= 22.5 (stable well before 24) and recent Bun.
 *
 * The schema is a stable public contract: external runtimes (Claude Code
 * hooks, review scripts, cron jobs) may insert rows directly with any
 * sqlite client, or shell out to `pi-spend log --json`. Idempotency comes
 * from the (runtime, session_id, entry_id) primary key: re-syncing a
 * session or re-running a hook never double-counts.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./config.ts";

export interface SpendEvent {
  runtime: string; // "pi" | "claude" | "script:kiln-review" | ...
  session_id: string;
  entry_id: string; // unique within (runtime, session_id)
  at: string; // ISO 8601 UTC
  cwd?: string;
  repo?: string; // basename of the project root
  phase?: string; // scout | plan | build | review | decide | other
  label?: string; // issue id, ledger id, or free-form tag
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost?: number; // USD. 0 for flat-rate subscriptions.
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  runtime     TEXT NOT NULL,
  session_id  TEXT NOT NULL DEFAULT '',
  entry_id    TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL,
  cwd         TEXT NOT NULL DEFAULT '',
  repo        TEXT NOT NULL DEFAULT '',
  phase       TEXT NOT NULL DEFAULT 'other',
  label       TEXT NOT NULL DEFAULT '',
  provider    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost        REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (runtime, session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string = dbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Insert if new. Returns true when the row was actually inserted. */
  record(e: SpendEvent): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (runtime, session_id, entry_id, at, cwd, repo, phase, label,
         provider, model, input, output, cache_read, cache_write, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      e.runtime,
      e.session_id ?? "",
      e.entry_id ?? "",
      e.at,
      e.cwd ?? "",
      e.repo ?? "",
      e.phase || "other",
      e.label ?? "",
      e.provider ?? "",
      e.model ?? "",
      Math.round(e.input ?? 0),
      Math.round(e.output ?? 0),
      Math.round(e.cache_read ?? 0),
      Math.round(e.cache_write ?? 0),
      e.cost ?? 0,
    );
    return Number(r.changes) > 0;
  }

  rows(where = "1=1", params: (string | number)[] = []): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where} ORDER BY at`)
      .all(...params) as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}
