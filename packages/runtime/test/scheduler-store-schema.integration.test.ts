import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";

let dir: string;
let store: RuntimeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acpus-scheduler-schema-"));
  store = await openRuntimeStore(dir);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("scheduler store schema", () => {
  it("creates durable scheduler projection tables and query indexes", () => {
    const db = new DatabaseSync(join(dir, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
    try {
      expect(sqliteNames(db, "table")).toEqual(expect.arrayContaining([
        "run_leases",
        "scheduler_commits",
        "scheduler_frames",
        "node_instances",
        "node_attempts",
        "group_members",
        "signal_waits",
        "execution_metadata",
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
        "item_key",
        "item_index",
        "item_json",
        "child_frame_key",
      ]));
      expect(columns(db, "signal_waits")).toEqual(expect.arrayContaining([
        "deadline_at",
        "timeout_message",
        "timeout_remaining_ms",
      ]));
      expect(sqliteNames(db, "index")).toEqual(expect.arrayContaining([
        "idx_run_leases_expires",
        "idx_node_instances_node_status",
        "idx_node_attempts_deadline_status",
        "idx_group_members_ready",
        "idx_signal_waits_deadline_status",
      ]));
    } finally {
      db.close();
    }
  });
});

function sqliteNames(db: DatabaseSync, type: "table" | "index"): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type).map(row => String(row.name));
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
}
