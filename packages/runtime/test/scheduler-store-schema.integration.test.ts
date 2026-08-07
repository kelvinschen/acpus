import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import { getRuntimeHealth } from "../src/runs/use-cases.js";
import {
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  openRuntimeStore,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
  type RuntimeStore,
} from "../src/store/store.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { prepareSyntheticWorkflow, validWorkflow } from "./support/runtime-fixtures.js";
import { runtimeStateFingerprint } from "./support/tree-fingerprint.js";

let dir: string;
let runtimeHome: string;
let restoreRuntimeHome: () => void;
let store: RuntimeStore | undefined;

beforeEach(async () => {
  [dir, runtimeHome] = await Promise.all([
    mkdtemp(join(tmpdir(), "acpus-scheduler-schema-")),
    mkdtemp(join(tmpdir(), "acpus-scheduler-schema-home-")),
  ]);
  restoreRuntimeHome = setRuntimeHomeForTest(dir, runtimeHome);
  store = await openRuntimeStore(dir);
});

afterEach(async () => {
  store?.close();
  restoreRuntimeHome();
  await Promise.all([
    rm(dir, { recursive: true, force: true }),
    rm(runtimeHome, { recursive: true, force: true }),
  ]);
});

describe("scheduler store format", () => {
  it("marks a fresh database with the current Acpus storage format", () => {
    const db = new DatabaseSync(resolveRuntimeLayout(dir).databasePath, { readOnly: true });
    try {
      expect(databaseFormat(db)).toEqual({
        applicationId: RUNTIME_APPLICATION_ID,
        userVersion: RUNTIME_STORAGE_VERSION,
      });
    } finally {
      db.close();
    }
  });

  it("stores fork session groups separately from their replay facts", () => {
    const db = new DatabaseSync(resolveRuntimeLayout(dir).databasePath, { readOnly: true });
    try {
      expect(tableColumns(db, "fork_replay_session_groups")).toEqual([
        "run_id",
        "session_group_digest",
        "member_count",
        "replayed_count",
      ]);
      expect(tableColumns(db, "fork_replay_facts")).toEqual([
        "run_id",
        "node_key",
        "source_run_id",
        "source_sequence",
        "operation_digest",
        "input_digest",
        "session_group_digest",
        "output_json",
        "artifacts_json",
      ]);
    } finally {
      db.close();
    }
  });

  it("owns bounded SQLite-only Agent observations in current storage", () => {
    const db = new DatabaseSync(resolveRuntimeLayout(dir).databasePath, { readOnly: true });
    try {
      expect(tableColumns(db, "runs")).toEqual(expect.arrayContaining([
        "observation_version",
        "observation_updated_at",
      ]));
      expect(tableColumns(db, "agent_observation_attempts")).toEqual(expect.arrayContaining([
        "run_id",
        "attempt_id",
        "latest_observation_version",
        "retention_omitted_count",
        "retention_floor_version",
      ]));
      const observationTurnColumns = tableColumns(db, "agent_observation_turns");
      expect(observationTurnColumns).toEqual([
        "run_id",
        "attempt_id",
        "node_key",
        "node_id",
        "attempt_no",
        "turn_no",
        "prompt_kind",
        "state",
        "degraded",
        "gap_count",
        "provider_event_count",
        "unknown_event_count",
        "fence_event_sequence",
        "fenced_at",
        "fence_reason",
        "provider_status",
        "current_json",
        "current_bytes",
        "current_updated_at",
        "current_observation_version",
        "started_at",
        "finished_at",
      ]);
      expect(tableColumns(db, "agent_observation_entries")).toEqual(expect.arrayContaining([
        "run_id",
        "attempt_id",
        "turn_no",
        "entry_id",
        "observation_version",
        "source_sequence",
        "kind",
        "payload_json",
        "payload_bytes",
      ]));
      expect(tableColumns(db, "agent_observation_batches")).toEqual([]);
      const turnsSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_observation_turns'")
        .get() as { sql: string };
      expect(turnsSql.sql).toContain("UNIQUE (run_id, fence_event_sequence)");
      expect(turnsSql.sql).toContain("state IN ('recording', 'settled', 'incomplete')");
    } finally {
      db.close();
    }
  });

  it("rejects storage v6 without a compatibility read path", async () => {
    store?.close();
    store = undefined;
    const layout = resolveRuntimeLayout(dir);
    setDatabaseFormat(layout.databasePath, {
      applicationId: RUNTIME_APPLICATION_ID,
      userVersion: 6,
    });
    const beforeDoctor = await runtimeStateFingerprint(layout.workspaceRoot);

    await expect(openExistingRuntimeStore(dir)).rejects.toMatchObject({
      name: "IncompatibleRuntimeDatabaseError",
      applicationId: RUNTIME_APPLICATION_ID,
      userVersion: 6,
    });
    await expect(getRuntimeHealth(dir)).resolves.toEqual({
      ok: true,
      phase: "doctor",
      state: "unreadable",
      persistence: { path: layout.workspaceRoot },
      checks: [{
        area: "store",
        status: "warn",
        message: `Runtime storage version 6 is older than the supported version ${RUNTIME_STORAGE_VERSION}. Doctor made no changes. This workspace remains usable; starting a new workflow run will prepare compatible storage automatically.`,
      }],
    });
    expect(await runtimeStateFingerprint(layout.workspaceRoot)).toBe(beforeDoctor);
  });

  it.each([
    {
      name: "storage version zero",
      applicationId: RUNTIME_APPLICATION_ID,
      userVersion: 0,
    },
    {
      name: "newer storage",
      applicationId: RUNTIME_APPLICATION_ID,
      userVersion: RUNTIME_STORAGE_VERSION + 1,
    },
    {
      name: "another application",
      applicationId: RUNTIME_APPLICATION_ID + 1,
      userVersion: 1,
    },
  ])("keeps $name as a Doctor failure", async ({ applicationId, userVersion }) => {
    store?.close();
    store = undefined;
    const layout = resolveRuntimeLayout(dir);
    setDatabaseFormat(layout.databasePath, { applicationId, userVersion });

    await expect(getRuntimeHealth(dir)).resolves.toEqual({
      ok: false,
      phase: "doctor",
      state: "unreadable",
      persistence: { path: layout.workspaceRoot },
      checks: [{
        area: "store",
        status: "fail",
        message: `Runtime database '${layout.databasePath}' uses application_id ${applicationId} and user_version ${userVersion}; expected ${RUNTIME_APPLICATION_ID} and ${RUNTIME_STORAGE_VERSION}.`,
      }],
    });
  });

  it("preserves admitted run semantics across read-only and writable reopen", async () => {
    if (!store) throw new Error("expected fresh runtime store");
    const prepared = await prepareSyntheticWorkflow(dir, validWorkflow());
    const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: dir });
    store.close();
    store = undefined;
    const layout = resolveRuntimeLayout(dir);
    const beforeRead = await runtimeStateFingerprint(layout.workspaceRoot);

    const readOnly = await openExistingRuntimeStore(dir);
    if (!readOnly) throw new Error("expected existing runtime store");
    expect(readOnly.getRun(run.id)).toMatchObject({
      id: run.id,
      status: "pending",
      input: { ready: true },
    });
    expect(readOnly.getFrozenRun(run.id)).toMatchObject({
      ir: { name: "cli-valid" },
      input: { ready: true },
    });
    expect(readOnly.getHookDispatchCursor(run.id)).toBe(0);
    expect(() => readOnly.pruneHookJournal(new Date())).toThrow(expect.objectContaining({
      code: "ERR_SQLITE_ERROR",
    }));
    readOnly.close();
    expect(await runtimeStateFingerprint(layout.workspaceRoot)).toBe(beforeRead);

    store = await openExistingWritableRuntimeStore(dir);
    expect(store?.getRun(run.id)).toMatchObject({ id: run.id, status: "pending" });
    expect(store?.getHookDispatchCursor(run.id)).toBe(0);
  });

  it.skipIf(process.platform === "win32")("only treats ENOENT and ENOTDIR store paths as absent", async () => {
    store?.close();
    store = undefined;
    const runtimeRoot = resolveRuntimeLayout(dir).runtimeRoot;
    await rm(runtimeRoot, { recursive: true, force: true });
    await writeFile(runtimeRoot, "not a directory");
    await expect(openExistingRuntimeStore(dir)).resolves.toBeUndefined();

    await rm(runtimeRoot);
    await symlink("runtime", runtimeRoot);
    await expect(openExistingRuntimeStore(dir)).rejects.toMatchObject({ code: "ELOOP" });
  });
});

function databaseFormat(db: DatabaseSync): { applicationId: number; userVersion: number } {
  const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return {
    applicationId: Number(application.application_id),
    userVersion: Number(version.user_version),
  };
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function setDatabaseFormat(
  path: string,
  format: { applicationId: number; userVersion: number },
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA application_id = ${format.applicationId};
      PRAGMA user_version = ${format.userVersion};
    `);
  } finally {
    db.close();
  }
}
