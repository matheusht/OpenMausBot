// Durable event log for harness turns — the port's spine substrate (ADR 0002).
//
// avenza proved that a turn can be made inspectable, resumable, and
// benchmarkable if every state change is an envelope event committed to a
// per-turn monotonic sequence BEFORE anyone is told about it. This module
// lands that discipline on the same primitives as message-db.ts:
// node:sqlite, one file beside messages.db, no new dependencies.
//
// Contract (mirrors avenza db/event-producer.ts):
//   - envelope: { schema_version, event_id, turn_id, seq, occurred_at,
//     family, kind, item_id?, causation_id?, trace_id?, payload }
//   - seq is service-generated: MAX(seq)+1 inside BEGIN IMMEDIATE. The
//     synchronous single-writer runtime makes an advisory lock unnecessary.
//   - commit-before-publish: each append also writes an event_outbox row in
//     the SAME transaction; publishers drain it after COMMIT. A crash
//     between commit and publish is repaired by drainOutbox() at boot.
//   - secrets are redacted before the INSERT, never after (what hit disk
//     stays clean even if a later redaction rule changes).
//
// synchronous=FULL is a deliberate divergence from messages.db (NORMAL):
// the event log is the resume/audit authority, so a committed seq must
// survive power loss, not just app crash. Turn-scale write rates make the
// extra fsync negligible.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";

export type EventFamily = "stream" | "capture" | "narrative";

export interface EventEnvelope {
  schema_version: 1;
  event_id: string;
  turn_id: string;
  seq: number;
  occurred_at: string;
  family: EventFamily;
  kind: string;
  item_id?: string;
  causation_id?: string;
  trace_id?: string;
  payload: unknown;
}

const DB_FILE = () => join(DATA_DIR, "events.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

const SCHEMA_VERSION = 1;

function open(): DatabaseSync {
  const file = DB_FILE();
  // Boot calls ensureDirs(), but the log must also work standalone (tests,
  // tooling) — so provision the directory here rather than assuming it.
  mkdirSync(DATA_DIR, { recursive: true });
  // Same owner-only posture as messages.db — envelopes carry tool output.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

// user_version-counter migrations. Each step runs its DDL and the version
// bump inside one transaction (SQLite DDL is transactional). Base DDL keeps
// IF NOT EXISTS so fresh and upgraded databases converge on the same shape.
function migrate(db: DatabaseSync): void {
  const current = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  const steps: Array<(database: DatabaseSync) => void> = [
    (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS events (
          turn_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          family TEXT NOT NULL,
          kind TEXT NOT NULL,
          item_id TEXT,
          occurred_at TEXT NOT NULL,
          envelope TEXT NOT NULL,
          PRIMARY KEY (turn_id, seq)
        );
        CREATE TABLE IF NOT EXISTS event_outbox (
          turn_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          published INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (turn_id, seq)
        );
        CREATE TABLE IF NOT EXISTS turns (
          turn_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
    // v2: thread ownership on events — the eval seam resolves "the latest
    // turn of this thread" through this column (drivers speak in threads;
    // drivers' turn ids are minted inside the provider layer).
    (database) => {
      database.exec("ALTER TABLE events ADD COLUMN thread_id TEXT");
      database.exec("CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id)");
    },
  ];
  for (let v = current; v < steps.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      steps[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** The live handle — reopened when tests wipe DATA_DIR out from under us. */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

export interface CommitEventInput {
  turn_id: string;
  /** owning thread, when known — enables thread→turn lookups */
  thread_id?: string;
  family: EventFamily;
  kind: string;
  item_id?: string;
  causation_id?: string;
  trace_id?: string;
  payload?: unknown;
}

/**
 * Append one envelope: allocate the next seq, redact, insert event + outbox
 * row atomically, return the committed envelope. Publish only after this
 * returns — subscribers must never see an event that isn't on disk.
 */
export function commitEvent(input: CommitEventInput): EventEnvelope {
  const database = db();
  const envelope: EventEnvelope = {
    schema_version: SCHEMA_VERSION,
    event_id: randomUUID(),
    turn_id: input.turn_id,
    seq: -1,
    occurred_at: new Date().toISOString(),
    family: input.family,
    kind: input.kind,
    payload: input.payload ?? null,
  };
  if (input.item_id !== undefined) envelope.item_id = input.item_id;
  if (input.causation_id !== undefined) envelope.causation_id = input.causation_id;
  if (input.trace_id !== undefined) envelope.trace_id = input.trace_id;
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE turn_id = ?").get(input.turn_id);
    // SAFETY: the SELECT projects exactly one aliased column, `next`.
    envelope.seq = (row as { next: number }).next;
    // Redact at the boundary: what hits disk is what everyone reads back.
    // SAFETY: redactSecrets deep-walks and returns the same object shape
    // it was given; only string values may change.
    const clean = redactSecrets(envelope) as EventEnvelope;
    database
      .prepare(
        "INSERT INTO events (turn_id, seq, event_id, family, kind, item_id, occurred_at, envelope, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        clean.turn_id,
        clean.seq,
        clean.event_id,
        clean.family,
        clean.kind,
        clean.item_id ?? null,
        clean.occurred_at,
        JSON.stringify(clean),
        input.thread_id ?? null,
      );
    database
      .prepare("INSERT INTO event_outbox (turn_id, seq, published) VALUES (?, ?, 0)")
      .run(clean.turn_id, clean.seq);
    ensureTurnRow(clean.turn_id);
    database.exec("COMMIT");
    return clean;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function ensureTurnRow(turnId: string): void {
  db()
    .prepare("INSERT OR IGNORE INTO turns (turn_id, state, revision) VALUES (?, 'accepted', 0)")
    .run(turnId);
}

/** CAS the turn state forward; returns false when someone else moved first. */
export function transitionTurnState(turnId: string, from: string, to: string): boolean {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare("UPDATE turns SET state = ?, revision = revision + 1 WHERE turn_id = ? AND state = ?")
      .run(to, turnId, from);
    database.exec("COMMIT");
    return result.changes === 1;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function insertTurnRow(turnId: string, state: string): void {
  db().prepare("INSERT OR IGNORE INTO turns (turn_id, state, revision) VALUES (?, ?, 0)").run(turnId, state);
}

export interface TurnStatusRow {
  turn_id: string;
  state: string;
  revision: number;
  last_committed_seq: number;
}

export function turnStatus(turnId: string): TurnStatusRow | null {
  const row = db()
    .prepare(
      "SELECT t.turn_id, t.state, t.revision, COALESCE((SELECT MAX(seq) FROM events WHERE turn_id = t.turn_id), 0) AS last_committed_seq FROM turns t WHERE t.turn_id = ?",
    )
    .get(turnId);
  // SAFETY: the SELECT projects exactly turn_id/state/revision plus the
  // aliased max-seq column, matching TurnStatusRow's fields.
  return (row as TurnStatusRow | undefined) ?? null;
}

/** Replay events strictly after `afterSeq`, oldest first. */
export function eventsSince(turnId: string, afterSeq: number): EventEnvelope[] {
  const rows = db()
    .prepare("SELECT envelope FROM events WHERE turn_id = ? AND seq > ? ORDER BY seq")
    .all(turnId, afterSeq);
  // SAFETY: the only projected column is `envelope`, written by commitEvent
  // as JSON.stringify of an EventEnvelope.
  return (rows as Array<{ envelope: string }>).map((row) => JSON.parse(row.envelope) as EventEnvelope);
}

/** Rows committed but never published — the crash-between-commit-and-publish repair. */
export function unpublishedEvents(): Array<{ turn_id: string; seq: number }> {
  const rows = db()
    .prepare("SELECT turn_id, seq FROM event_outbox WHERE published = 0 ORDER BY turn_id, seq")
    .all();
  // SAFETY: the SELECT projects exactly the two outbox key columns.
  return rows as Array<{ turn_id: string; seq: number }>;
}

export function markPublished(turnId: string, seq: number): void {
  db().prepare("UPDATE event_outbox SET published = 1 WHERE turn_id = ? AND seq = ?").run(turnId, seq);
}

/** The most recent real turn of a thread (thread-scoped session events
 * excluded). Null when the thread has no provider turn yet. */
export function latestTurnForThread(threadId: string): string | null {
  const row = db()
    .prepare("SELECT turn_id FROM events WHERE thread_id = ? AND turn_id != ? ORDER BY rowid DESC LIMIT 1")
    .get(threadId, threadId);
  // SAFETY: the SELECT projects exactly the turn_id column.
  return (row as { turn_id: string } | undefined)?.turn_id ?? null;
}

/** Count of a kind for a turn — the eval runner's iteration proxy. */
export function countKind(turnId: string, kind: string): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = ? AND kind = ?").get(turnId, kind);
  // SAFETY: COUNT(*) projects exactly one integer column.
  return (row as { n: number }).n;
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeEventDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
