import { admitRunForTest } from "./support/runtime-store.js";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

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
        await expect(access(join(workspace, ".acpus", ".local", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
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
      const runsDir = join(workspace, ".acpus", ".local", "runs");
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
      const runsDir = join(workspace, ".acpus", ".local", "runs");
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
