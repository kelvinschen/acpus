import { admitRunForTest } from "./support/runtime-store.js";
import { access, cp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryFence } from "../src/store/path-fence.js";
import { openRuntimeStore, publishRunDirectory } from "../src/store/store.js";
import { preparedWorkflow, prepareSyntheticWorkflow, runtimeRunsRoot, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

const runIdBytes = vi.hoisted(() => ({ values: [] as number[] }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomBytes: (size: number) => Buffer.alloc(size, runIdBytes.values.shift() ?? 0),
}));

describe("runtime run directory publication", () => {
  beforeEach(() => {
    runIdBytes.values = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns tagged prepared, input, and Agent override failures without mutation", async () => {
    await withRuntimeWorkspace("runtime-admission-tagged-failures", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const invalidIr = { ...prepared.ir, irVersion: 999 } as any;
        expect((await store.admitRun({
          prepared: preparedWorkflow(invalidIr, join(workspace, prepared.source.entry), workspace),
          cwd: workspace,
          input: { ready: true },
        }))._unsafeUnwrapErr()).toMatchObject({
          type: "prepared-workflow-invalid",
          reason: "invalid-ir",
        });

        expect((await store.admitRun({
          prepared: { ...prepared, irJson: "{}" },
          cwd: workspace,
          input: { ready: true },
        }))._unsafeUnwrapErr()).toMatchObject({ type: "prepared-workflow-invalid" });

        expect((await store.admitRun({
          prepared,
          cwd: workspace,
          input: { ready: "yes" } as any,
        }))._unsafeUnwrapErr()).toMatchObject({ type: "schema-mismatch", path: "$.ready" });

        expect((await store.admitRun({
          prepared,
          cwd: workspace,
          input: { ready: true },
          agentOverrides: { missing: { use: "codex" } },
        }))._unsafeUnwrapErr()).toMatchObject({ type: "agent-overrides-invalid" });

        expect(store.listRuns()).toEqual([]);
        await expect(readdir(runtimeRunsRoot(workspace))).resolves.toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("rejects an admission workspace split before filesystem or database mutation", async () => {
    await withRuntimeWorkspace("runtime-admission-workspace-split", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const otherWorkspace = join(workspace, "other-workspace");
      await mkdir(otherWorkspace);
      try {
        await expect(admitRunForTest(store, { prepared, cwd: otherWorkspace, input: { ready: true } })).rejects.toThrow(
          "Admission workspace does not match the runtime store workspace.",
        );
        expect(store.listRuns()).toEqual([]);
        await expect(access(join(otherWorkspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        store.close();
      }
    });
  });

  it("preserves pre-existing admission staging and final directories", async () => {
    await withRuntimeWorkspace("runtime-admission-path-ownership", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const runsDir = runtimeRunsRoot(workspace);
      await mkdir(runsDir, { recursive: true });
      try {
        const stagingRunId = deterministicRunId(0xaa);
        const stagingDir = join(runsDir, `.staging-${stagingRunId}`);
        await mkdir(stagingDir);
        await writeFile(join(stagingDir, "sentinel.txt"), "owned by another operation");
        runIdBytes.values.push(0xaa);

        await expect(admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } })).rejects.toMatchObject({ code: "EEXIST" });
        await expect(readFile(join(stagingDir, "sentinel.txt"), "utf8")).resolves.toBe("owned by another operation");
        expect(store.listRuns()).toEqual([]);

        await rm(stagingDir, { recursive: true });
        const finalRunId = deterministicRunId(0xbb);
        const finalDir = join(runsDir, finalRunId);
        await mkdir(finalDir);
        await writeFile(join(finalDir, "sentinel.txt"), "pre-existing final");
        runIdBytes.values.push(0xbb);

        await expect(admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } })).rejects.toThrow("already exists");
        await expect(readFile(join(finalDir, "sentinel.txt"), "utf8")).resolves.toBe("pre-existing final");
        await expect(access(join(runsDir, `.staging-${finalRunId}`))).rejects.toThrow();
        expect(store.listRuns()).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("preserves pre-existing fork staging and final directories", async () => {
    await withRuntimeWorkspace("runtime-fork-path-ownership", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const runsDir = runtimeRunsRoot(workspace);
      try {
        runIdBytes.values.push(0xaa);
        const source = await admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } });

        const stagingForkId = deterministicRunId(0xbb);
        const stagingDir = join(runsDir, `.staging-${stagingForkId}`);
        await mkdir(stagingDir);
        await writeFile(join(stagingDir, "sentinel.txt"), "owned by another fork");
        runIdBytes.values.push(0xbb);

        await expect(store.forkRun(source.id).then(result => result._unsafeUnwrap())).rejects.toMatchObject({ code: "EEXIST" });
        await expect(readFile(join(stagingDir, "sentinel.txt"), "utf8")).resolves.toBe("owned by another fork");
        expect(store.listRuns().map(run => run.id)).toEqual([source.id]);

        await rm(stagingDir, { recursive: true });
        const finalForkId = deterministicRunId(0xcc);
        const finalDir = join(runsDir, finalForkId);
        await mkdir(finalDir);
        await writeFile(join(finalDir, "sentinel.txt"), "pre-existing fork final");
        runIdBytes.values.push(0xcc);

        await expect(store.forkRun(source.id).then(result => result._unsafeUnwrap())).rejects.toThrow("already exists");
        await expect(readFile(join(finalDir, "sentinel.txt"), "utf8")).resolves.toBe("pre-existing fork final");
        await expect(access(join(runsDir, `.staging-${finalForkId}`))).rejects.toThrow();
        expect(store.listRuns().map(run => run.id)).toEqual([source.id]);
      } finally {
        store.close();
      }
    });
  });

  it("reports an orphan final run directory without deleting it", async () => {
    await withRuntimeWorkspace("runtime-orphan-run-publication", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = deterministicRunId(0xdd);
      const sentinel = join(runtimeRunsRoot(workspace), runId, "sentinel.txt");
      await mkdir(dirname(sentinel), { recursive: true });
      await writeFile(sentinel, "uncommitted publication");
      try {
        await expect(store.cleanupStagedRunDirectories()).rejects.toThrow();
        await expect(readFile(sentinel, "utf8")).resolves.toBe("uncommitted publication");
        expect(store.listRuns()).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("revalidates the opened runs root after asynchronous staging population", async () => {
    await withRuntimeWorkspace("runtime-publication-root-swap", async workspace => {
      const runsRoot = runtimeRunsRoot(workspace);
      const relocatedRunsRoot = `${runsRoot}.opened`;
      await mkdir(runsRoot, { recursive: true });
      const publicationReady = deferred<void>();
      const resumePublication = deferred<void>();
      const runId = deterministicRunId(0xdd);
      const publication = publishRunDirectory({
        runsRoot: new DirectoryFence(runsRoot, "Runtime runs root"),
        runId,
        platform: process.platform,
        populate: async stagingDir => {
          await writeFile(join(stagingDir, "workflow.ir.json"), "{}\n");
          publicationReady.resolve();
          await resumePublication.promise;
        },
      });
      await publicationReady.promise;
      await rename(runsRoot, relocatedRunsRoot);
      await mkdir(runsRoot);
      await writeFile(join(runsRoot, "sentinel"), "replacement");
      try {
        resumePublication.resolve();
        let failure: unknown;
        try {
          await publication;
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        await expect(readFile(join(runsRoot, "sentinel"), "utf8")).resolves.toBe("replacement");
        await expect(readdir(runsRoot)).resolves.toEqual(["sentinel"]);
        await expect(readFile(join(relocatedRunsRoot, runId, "workflow.ir.json"), "utf8"))
          .resolves.toBe("{}\n");
        await expect(readdir(join(relocatedRunsRoot, `.staging-${runId}`))).resolves.toEqual([]);
      } finally {
        resumePublication.resolve();
        await rm(runsRoot, { recursive: true });
        await rename(relocatedRunsRoot, runsRoot);
      }
    });
  });

  it("returns absence only for missing rows and rejects a substituted run capsule before writes", async () => {
    await withRuntimeWorkspace("runtime-run-capsule-lookup", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } });
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected admitted run directory");
        expect(store.getRunDir(deterministicRunId(0xee))).toBeUndefined();

        const outside = join(workspace, "outside-run");
        await rename(runDir, outside);
        expect(() => store.getRunDir(run.id)).toThrow();

        await symlink(outside, runDir, process.platform === "win32" ? "junction" : "dir");
        await expect((async () => {
          const selected = store.getRunDir(run.id);
          if (!selected) throw new Error("expected persisted run row");
          await mkdir(join(selected, "artifacts"), { recursive: true });
          await writeFile(join(selected, "artifacts", "escaped.txt"), "escaped");
        })()).rejects.toThrow();
        await expect(access(join(outside, "artifacts", "escaped.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        store.close();
      }
    });
  });

  it.skipIf(process.platform === "win32")("rejects a substituted runtime ancestor before exposing a run directory", async () => {
    await withRuntimeWorkspace("runtime-run-capsule-ancestor", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } });
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected admitted run directory");
        const runtimeRoot = dirname(dirname(runDir));
        const relocatedRuntimeRoot = `${runtimeRoot}.relocated`;
        await rename(runtimeRoot, relocatedRuntimeRoot);
        try {
          await symlink(relocatedRuntimeRoot, runtimeRoot, "dir");
          try {
            expect(() => store.getFrozenRun(run.id)).toThrow();
            await expect(store.deleteRun(run.id)).rejects.toThrow();
            expect(store.getRun(run.id)?.id).toBe(run.id);
            await expect((async () => {
              const selected = store.getRunDir(run.id);
              if (!selected) throw new Error("expected persisted run row");
              await writeFile(join(selected, "ancestor-escaped.txt"), "escaped");
            })()).rejects.toThrow();
            await expect(access(join(relocatedRuntimeRoot, "runs", run.id, "ancestor-escaped.txt")))
              .rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            await unlink(runtimeRoot);
          }
        } finally {
          await rename(relocatedRuntimeRoot, runtimeRoot);
        }
      } finally {
        store.close();
      }
    });
  });

  it.skipIf(process.platform === "win32")("rejects a same-path runs-root replacement by directory identity", async () => {
    await withRuntimeWorkspace("runtime-runs-root-identity", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } });
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected admitted run directory");
        const runsRoot = dirname(runDir);
        const relocatedRunsRoot = `${runsRoot}.relocated`;
        await rename(runsRoot, relocatedRunsRoot);
        try {
          await mkdir(runsRoot);
          await cp(join(relocatedRunsRoot, run.id), join(runsRoot, run.id), { recursive: true });
          try {
            expect(() => store.getRunDir(run.id)).toThrow();
            expect(() => store.getFrozenRun(run.id)).toThrow();
          } finally {
            await rm(runsRoot, { recursive: true });
          }
        } finally {
          await rename(relocatedRunsRoot, runsRoot);
        }
      } finally {
        store.close();
      }
    });
  });
});

function deterministicRunId(byte: number): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ].map(value => String(value).padStart(2, "0")).join("");
  return `${timestamp}${byte.toString(16).padStart(2, "0").toUpperCase().repeat(10)}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
