import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openExistingRuntimeStore, openExistingWritableRuntimeStore, openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, validWorkflow } from "./support/runtime-fixtures.js";

let dir: string;
let store: RuntimeStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-scheduler-schema-"));
  store = await openRuntimeStore(dir);
});

afterEach(async () => {
  store?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("scheduler store schema", () => {
  it("initializes the complete current schema for a fresh store", () => {
    const db = new DatabaseSync(join(dir, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
    try {
      expect(sqliteNames(db, "table")).toEqual(expect.arrayContaining([
        "artifacts",
        "daemon_lease",
        "execution_metadata",
        "group_members",
        "hook_journal",
        "node_attempts",
        "node_instances",
        "node_progress",
        "node_states",
        "run_events",
        "run_leases",
        "run_inputs",
        "runs",
        "scheduler_commits",
        "scheduler_frames",
        "signal_waits",
      ]));
      expect(columns(db, "node_instances")).toEqual(expect.arrayContaining([
        "run_id",
        "node_key",
        "node_id",
        "parent_frame_key",
        "instance_path_json",
        "status",
        "readiness_sequence",
        "accepted_attempt_id",
      ]));
      expect(columns(db, "scheduler_frames")).toEqual(expect.arrayContaining([
        "frame_key",
        "parent_frame_key",
        "node_key",
        "node_id",
        "frame_kind",
        "instance_path_json",
        "scope_json",
        "loop_json",
      ]));
      expect(columns(db, "node_attempts")).toEqual(expect.arrayContaining([
        "attempt_id",
        "node_key",
        "attempt_no",
        "owner_epoch",
        "deadline_at",
        "terminal_reason",
      ]));
      expect(columns(db, "group_members")).toEqual(expect.arrayContaining([
        "member_key",
        "item_index",
        "item_json",
        "child_frame_key",
      ]));
      expect(columns(db, "signal_waits")).toEqual(expect.arrayContaining([
        "deadline_at",
        "timeout_message",
        "timeout_remaining_ms",
      ]));
      expect(columns(db, "scheduler_commits")).toEqual(expect.arrayContaining([
        "event_digest",
        "intent_digest",
      ]));
      expect(columnConstraints(db, "scheduler_commits", ["event_digest", "intent_digest"])).toEqual([
        { name: "event_digest", notnull: 1 },
        { name: "intent_digest", notnull: 0 },
      ]);
      expect(columns(db, "hook_journal")).toEqual(expect.arrayContaining([
        "run_id",
        "event_sequence",
        "trigger_order",
        "definition_hash",
        "status",
        "triggered_at",
      ]));
      expect(columnConstraints(db, "run_inputs", [
        "workflow_ir_path", "workflow_ir_digest", "lock_path", "lock_digest", "run_dir",
      ])).toEqual([
        { name: "workflow_ir_path", notnull: 1 },
        { name: "workflow_ir_digest", notnull: 1 },
        { name: "lock_path", notnull: 1 },
        { name: "lock_digest", notnull: 1 },
        { name: "run_dir", notnull: 1 },
      ]);
      expect(columnConstraints(db, "signal_waits", ["created_at", "updated_at"])).toEqual([
        { name: "created_at", notnull: 1 },
        { name: "updated_at", notnull: 1 },
      ]);
      expect(sqliteNames(db, "index")).toEqual(expect.arrayContaining([
        "idx_group_members_status",
        "idx_group_members_ready",
        "idx_hook_journal_event_handler",
        "idx_hook_journal_run_id",
        "idx_hook_journal_triggered_at",
        "idx_node_attempts_deadline_status",
        "idx_node_attempts_owner_status",
        "idx_node_instances_frame_status",
        "idx_run_leases_expires",
        "idx_node_instances_node_status",
        "idx_node_progress_run_updated",
        "idx_scheduler_frames_parent_status",
        "idx_signal_waits_status",
        "idx_signal_waits_deadline_status",
      ]));
    } finally {
      db.close();
    }
  });

  it("reopens a current writable store without changing its schema or rows", async () => {
    const databasePath = join(dir, ".acpus", ".local", "state", "runtime.db");
    if (!store) throw new Error("expected fresh runtime store");
    const prepared = await prepareSyntheticWorkflow(dir, validWorkflow());
    const run = await store.admitRun({ prepared, input: { ready: true }, cwd: dir });
    const before = schemaVersion(databasePath);
    store.close();
    store = await openExistingWritableRuntimeStore(dir);

    expect(store).toBeDefined();
    expect(schemaVersion(databasePath)).toBe(before);
    expect(store?.getRun(run.id)).toMatchObject({ id: run.id, status: "pending", input: { ready: true } });
    expect(store?.getFrozenRun(run.id)).toMatchObject({ ir: { name: "cli-valid" }, input: { ready: true } });
  });

  it("opens a current store read-only without mutating it", async () => {
    const databasePath = join(dir, ".acpus", ".local", "state", "runtime.db");
    store?.close();
    store = undefined;
    const before = await readFile(databasePath);

    const readOnly = await openExistingRuntimeStore(dir);
    expect(readOnly).toBeDefined();
    if (!readOnly) throw new Error("expected existing runtime store");
    expect(readOnly.listRuns()).toEqual([]);
    expect(() => readOnly.pruneHookJournal(new Date())).toThrow(/readonly/i);
    readOnly.close();

    expect(await readFile(databasePath)).toEqual(before);
  });
});

function sqliteNames(db: DatabaseSync, type: "table" | "index"): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type).map(row => String(row.name));
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
}

function columnConstraints(db: DatabaseSync, table: string, names: string[]): Array<{ name: string; notnull: number }> {
  const selected = new Set(names);
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>)
    .filter(column => selected.has(column.name))
    .map(column => ({ name: column.name, notnull: Number(column.notnull) }));
}

function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  } finally {
    db.close();
  }
}
