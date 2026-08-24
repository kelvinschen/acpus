import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
import { openRuntimeExclusiveLock } from "../src/runtime-lock-adapter.js";
import { getRuntimeHealth, listRuns } from "../src/runs/use-cases.js";
import { acquireBoundRuntimeReadSession } from "../src/store/service.js";
import {
  openExistingRuntimeStoreAdapter,
  openExistingWritableRuntimeStoreAdapter,
  openRuntimeStoreAdapter,
  type RuntimeStoreAdapter,
} from "../src/store/store.js";
import {
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
  openRuntimeDatabase,
  readRuntimeDatabaseFormat,
} from "../src/storage/database.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { prepareSyntheticWorkflow, validWorkflow } from "./support/runtime-fixtures.js";
import { runtimeStateFingerprint } from "./support/tree-fingerprint.js";

let dir: string;
let runtimeHome: string;
let restoreRuntimeHome: () => void;
let store: RuntimeStoreAdapter | undefined;

beforeEach(async () => {
  [dir, runtimeHome] = await Promise.all([
    mkdtemp(join(tmpdir(), "acpus-scheduler-schema-")),
    mkdtemp(join(tmpdir(), "acpus-scheduler-schema-home-")),
  ]);
  restoreRuntimeHome = setRuntimeHomeForTest(dir, runtimeHome);
  store = await openRuntimeStoreAdapter(dir);
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

  it("requires execution metadata to reference an Attempt", () => {
    const db = new DatabaseSync(resolveRuntimeLayout(dir).databasePath, { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(execution_metadata)").all() as Array<{ name: string; notnull: number }>;
      expect(columns.find(column => column.name === "attempt_id")).toMatchObject({ notnull: 1 });
      expect(db.prepare("PRAGMA foreign_key_list(execution_metadata)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "node_attempts", from: "attempt_id", to: "attempt_id", on_delete: "CASCADE" }),
      ]));
    } finally {
      db.close();
    }
  });

  it("stores Agent Session authority and immutable Attempt lineage separately", () => {
    const db = new DatabaseSync(resolveRuntimeLayout(dir).databasePath, { readOnly: true });
    try {
      expect(tableColumns(db, "agent_sessions")).toEqual([
        "agent_session_id",
        "run_id",
        "scope_digest",
        "generation",
        "explicit_shared",
        "ready_at",
        "reported_version",
        "lifecycle",
        "checkpoint",
        "checkpoint_attempt_id",
        "checkpoint_turn_id",
        "checkpoint_session_lease_id",
        "checkpoint_prompt_origin",
        "checkpoint_input_digest",
        "checkpoint_at",
        "created_at",
        "updated_at",
      ]);
      expect(tableColumns(db, "agent_attempt_sessions")).toEqual([
        "attempt_id",
        "run_id",
        "agent_session_id",
        "operation",
        "session_open_mode",
        "predecessor_attempt_id",
        "steer_event_sequence",
        "initial_prompt_origin",
        "input_digest",
        "admitted_from_checkpoint",
        "created_at",
      ]);
      expect(db.prepare("PRAGMA foreign_key_list(agent_attempt_sessions)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: "runs", from: "run_id", to: "id", on_delete: "CASCADE" }),
        expect.objectContaining({ table: "agent_sessions", from: "agent_session_id", to: "agent_session_id", on_delete: "CASCADE" }),
      ]));
      expect(db.prepare("PRAGMA foreign_key_list(agent_attempt_sessions)").all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ table: "node_attempts" })]));
      const activeIndex = db.prepare(`
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'index' AND name = 'idx_agent_sessions_active_scope'
      `).get() as { sql: string };
      expect(activeIndex.sql).toContain("WHERE lifecycle = 'active'");
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

    await expect(openExistingRuntimeStoreAdapter(dir)).rejects.toMatchObject({
      name: "IncompatibleRuntimeDatabaseError",
      applicationId: RUNTIME_APPLICATION_ID,
      userVersion: 6,
    });
    expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(listRuns(dir))))))).toMatchObject({
      type: "runtime-store-repair-required",
    });
    await expect(Effect.runPromise(getRuntimeHealth(dir))).resolves.toEqual({
      ok: true,
      phase: "doctor",
      state: "unreadable",
      persistence: { path: layout.workspaceRoot },
      checks: [{
        area: "store",
        status: "warn",
        message: "The Runtime store needs repair for this version of Acpus. Run 'acpus doctor --fix'.",
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

    expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(listRuns(dir))))))).toMatchObject({
      type: "runtime-store-unsupported",
    });

    await expect(Effect.runPromise(getRuntimeHealth(dir))).resolves.toEqual({
      ok: false,
      phase: "doctor",
      state: "unreadable",
      persistence: { path: layout.workspaceRoot },
      checks: [{
        area: "store",
        status: "fail",
        message: `Runtime database uses application_id ${applicationId} and storage v${userVersion}.`,
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

    const readOnly = await openExistingRuntimeStoreAdapter(dir);
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

    store = await openExistingWritableRuntimeStoreAdapter(dir);
    expect(store?.getRun(run.id)).toMatchObject({ id: run.id, status: "pending" });
    expect(store?.getHookDispatchCursor(run.id)).toBe(0);
  });

  it("holds one shared runtime lock for the lifetime of a bound read session", async () => {
    store?.close();
    store = undefined;
    let now = 0;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* acquireBoundRuntimeReadSession(dir);
      if (!session) throw new Error("expected bound runtime read session");
      yield* Effect.promise(() => expect(openRuntimeExclusiveLock(resolveRuntimeLayout(dir), {
        now: () => now,
        wait: async () => { now += 1_000; },
      })).rejects.toMatchObject({ blocker: "runtime users" }));
    })));
    const lock = await openRuntimeExclusiveLock(resolveRuntimeLayout(dir), {
      now: () => now,
      wait: async () => { now += 1_000; },
    });
    await lock.release();
  });

  it.skipIf(process.platform === "win32")("distinguishes a missing active database from invalid runtime paths", async () => {
    store?.close();
    store = undefined;
    const layout = resolveRuntimeLayout(dir);
    await rm(layout.databasePath);
    await symlink("missing.db", layout.databasePath);
    await expect(readRuntimeDatabaseFormat(layout.databasePath)).rejects.toThrow("is not a regular file");
    await expect(openExistingRuntimeStoreAdapter(dir)).rejects.toMatchObject({
      failure: { type: "runtime-store-repair-required" },
      message: expect.stringContaining("entry 'runtime.db' has an invalid file type"),
    });

    const runtimeRoot = layout.runtimeRoot;
    await rm(runtimeRoot, { recursive: true, force: true });
    await writeFile(runtimeRoot, "not a directory");
    await expect(openExistingRuntimeStoreAdapter(dir)).rejects.toMatchObject({
      failure: { type: "runtime-store-repair-required" },
    });

    await rm(runtimeRoot);
    await symlink(basename(runtimeRoot), runtimeRoot);
    await expect(openExistingRuntimeStoreAdapter(dir)).rejects.toMatchObject({
      failure: { type: "runtime-store-repair-required" },
      message: expect.stringContaining("generation root is not a regular directory"),
    });
  });

  it.skipIf(process.platform === "win32").each(["-wal", "-shm"])(
    "rejects a symbolic-link %s sidecar before creating a fresh database",
    async suffix => {
      const databasePath = join(dir, `fresh${suffix}.db`);
      const sidecarPath = `${databasePath}${suffix}`;
      const target = join(dir, `outside${suffix}`);
      await writeFile(target, "sentinel\n");
      await symlink(target, sidecarPath);

      await expect(openRuntimeDatabase(databasePath)).rejects.toThrow("is not a regular file");
      expect((await lstat(sidecarPath)).isSymbolicLink()).toBe(true);
    },
  );
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
