import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../src/runtime-layout.js";
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
