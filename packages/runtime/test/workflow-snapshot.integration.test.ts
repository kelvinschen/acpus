import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tryPrepareWorkflow } from "@acpus/workflow-compiler";
import {
  getRun,
  requestDaemonAdmitRun,
  requestDaemonControl,
  startDaemonLoop,
} from "../src/index.js";
import type { PreparedRunWorkflow, Sha256Digest } from "../src/store/store.js";
import { openRuntimeStore } from "../src/store/store.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { waitForTerminalRun, waitUntil } from "./support/daemon-lease-fixture.js";
import {
  initializeRuntimeStoreForTest,
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  runtimeRow,
  runtimeRows,
  runtimeRunDir,
  snapshotPreparedWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { withSharedStorageHome } from "./support/storage-workspace.js";

describe("runtime workflow snapshots", () => {
  it("publishes one digest-addressed snapshot per workspace and reuses it without an original source directory", async () => {
    await withSharedStorageHome("workflow-snapshot", async ({ first, second }) => {
      const base = await prepareSyntheticWorkflow(first, validWorkflow());
      const prepared = snapshotPreparedWorkflow(base, [
        { path: "workflow.ts", content: "export const source = 'frozen';\n" },
        { path: "tasks/helper.ts", content: "export const helper = true;\n" },
      ]);

      const firstStore = await openRuntimeStore(first);
      const secondStore = await openRuntimeStore(second);
      try {
        const firstRun = await admitRunForTest(firstStore, { prepared, cwd: first, input: { ready: true } });
        const reusedRun = await admitRunForTest(firstStore, { prepared, cwd: first, input: { ready: true } });
        const secondRun = await admitRunForTest(secondStore, { prepared, cwd: second, input: { ready: true } });
        const firstSnapshot = snapshotPath(first, prepared.source.digest);
        const secondSnapshot = snapshotPath(second, prepared.source.digest);

        expect(firstSnapshot).not.toBe(secondSnapshot);
        expect(firstStore.getFrozenRun(firstRun.id)?.sourceRoot).toBe(firstSnapshot);
        expect(firstStore.getFrozenRun(reusedRun.id)?.sourceRoot).toBe(firstSnapshot);
        expect(secondStore.getFrozenRun(secondRun.id)?.sourceRoot).toBe(secondSnapshot);
        await expect(readFile(join(firstSnapshot, "workflow.ts"), "utf8"))
          .resolves.toBe("export const source = 'frozen';\n");
        await expect(readFile(join(secondSnapshot, "tasks/helper.ts"), "utf8"))
          .resolves.toBe("export const helper = true;\n");
        await expect(readFile(join(secondSnapshot, "workflow.ts"), "utf8"))
          .resolves.toBe("export const source = 'frozen';\n");
        expect(firstStore.listWorkflowSources()).toEqual([prepared.source, prepared.source]);
        expect(secondStore.listWorkflowSources()).toEqual([prepared.source]);
        const persisted = runtimeRow(first, "SELECT source_json FROM run_inputs WHERE run_id = ?", firstRun.id);
        expect(JSON.parse(String(persisted?.source_json))).toEqual(prepared.source);
        expect(String(persisted?.source_json)).not.toContain("frozen");
        expect(JSON.parse(await readFile(join(dirnameOfFiles(firstSnapshot), "manifest.json"), "utf8"))).toMatchObject({
          kind: "acpus_workflow_source_snapshot",
          version: 1,
          entry: "workflow.ts",
          digest: prepared.source.digest,
        });

        if (process.platform !== "win32") {
          await chmod(join(firstSnapshot, "workflow.ts"), 0o644);
          await expect(firstStore.admitRun({ prepared, cwd: first, input: { ready: true } }))
            .rejects.toThrow("not private");
          await chmod(join(firstSnapshot, "workflow.ts"), 0o600);
          expect(firstStore.listRuns()).toHaveLength(2);
        }

        await writeFile(join(firstSnapshot, "workflow.ts"), "tampered\n");
        await expect(firstStore.admitRun({ prepared, cwd: first, input: { ready: true } }))
          .rejects.toThrow("failed digest verification");
        expect(firstStore.readRunInspection(firstRun.id).frozen?.sourceRoot).toBeUndefined();
        expect(() => firstStore.getFrozenRun(firstRun.id)).toThrow("failed digest verification");
        expect(firstStore.listRuns()).toHaveLength(2);
      } finally {
        firstStore.close();
        secondStore.close();
      }
    });
  });

  it("rejects a same-path runtime sources-root replacement without publishing into it", async () => {
    await withSharedStorageHome("workflow-snapshot-root-identity", async ({ first }) => {
      const base = await prepareSyntheticWorkflow(first, validWorkflow());
      const prepared = snapshotPreparedWorkflow(base, [
        { path: "workflow.ts", content: "export const source = 'frozen';\n" },
      ]);
      const store = await openRuntimeStore(first);
      const sourcesRoot = resolveRuntimeLayout(first).sourcesRoot;
      const openedSourcesRoot = `${sourcesRoot}.opened`;
      try {
        await rename(sourcesRoot, openedSourcesRoot);
        await mkdir(sourcesRoot);
        await writeFile(join(sourcesRoot, "sentinel"), "replacement");
        try {
          await expect(admitRunForTest(store, {
            prepared,
            cwd: first,
            input: { ready: true },
          })).rejects.toThrow();
          await expect(readdir(sourcesRoot)).resolves.toEqual(["sentinel"]);
          expect(store.listRuns()).toEqual([]);
        } finally {
          await rm(sourcesRoot, { recursive: true });
          await rename(openedSourcesRoot, sourcesRoot);
        }
      } finally {
        store.close();
      }
    });
  });

  it("rejects an invalid bundle before publishing a source or run", async () => {
    await withRuntimeWorkspace("source-bundle-before-mutation", async workspace => {
      const base = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const valid = snapshotPreparedWorkflow(base, [
        { path: "helper.ts", content: "export const helper = true;\n" },
        { path: "workflow.ts", content: "export default 1;\n" },
      ]);
      if (valid.source.kind !== "snapshot") throw new Error("expected snapshot source");
      const invalid = {
        ...valid,
        sourceBundle: {
          ...valid.sourceBundle,
          files: [...valid.sourceBundle.files].reverse(),
        },
      } as PreparedRunWorkflow;
      const store = await openRuntimeStore(workspace);
      try {
        const admitted = await store.admitRun({ prepared: invalid, cwd: workspace, input: { ready: true } });
        expect(admitted.isErr()).toBe(true);
        expect(store.listRuns()).toEqual([]);
        expect(await readdir(resolveRuntimeLayout(workspace).sourcesRoot)).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("rejects persisted source metadata that drifts from the run row or preparation lock", async () => {
    await withRuntimeWorkspace("workflow-snapshot-persisted-source", async workspace => {
      const base = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const first = snapshotPreparedWorkflow(base, [
        { path: "workflow.ts", content: "export const source = 'first';\n" },
      ]);
      const second = snapshotPreparedWorkflow(base, [
        { path: "workflow.ts", content: "export const source = 'second';\n" },
      ]);
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared: first, cwd: workspace, input: { ready: true } });
        await admitRunForTest(store, { prepared: second, cwd: workspace, input: { ready: true } });

        updatePersistedSource(workspace, run.id, second.source, first.sourceGraphDigest);
        expect(() => store.getFrozenRun(run.id)).toThrow();
        expect(() => store.listWorkflowSources()).toThrow();

        updatePersistedSource(workspace, run.id, second.source, second.sourceGraphDigest);
        expect(() => store.getFrozenRun(run.id)).toThrow();

        updatePersistedSource(workspace, run.id, first.source, first.sourceGraphDigest, "other.ts");
        expect(() => store.getFrozenRun(run.id)).toThrow();
      } finally {
        store.close();
      }
    });
  });

  it.sequential("executes a compiler-captured external reusable Task after its original tree is deleted and the daemon restarts", async () => {
    await withRuntimeWorkspace("workflow-snapshot-recovery", async workspace => {
      const externalRoot = await mkdtemp(join(workspace, "..", "external-workflow-"));
      const sourceOnlyMarker = "ACPUS_SNAPSHOT_SOURCE_ONLY_7D13E4";
      try {
        await mkdir(join(externalRoot, "workflow"), { recursive: true });
        await mkdir(join(externalRoot, "shared"), { recursive: true });
        await writeFile(join(externalRoot, "workflow", "workflow.ts"), [
          `// ${sourceOnlyMarker}`,
          'import { defineWorkflow, z } from "acpus/core";',
          'import { durableTask } from "../shared/task.js";',
          "export default defineWorkflow({ name: \"external-durable\" }).build(({ step }) => {",
          "  const gate = step(\"gate\").signal({",
          "    outputSchema: z.object({ proceed: z.boolean() }),",
          "    prompt: \"continue after restart\",",
          "  });",
          "  const result = step(\"durable\").task({",
          "    task: durableTask,",
          "    input: { proceed: gate.output.proceed },",
          "  });",
          "  return { value: result.output.value };",
          "});",
          "",
        ].join("\n"));
        await writeFile(join(externalRoot, "shared", "task.ts"), [
          'import { task, z } from "acpus/core";',
          'import { decorate } from "./helper.js";',
          "export const durableTask = task.define({",
          "  inputSchema: z.object({ proceed: z.boolean() }),",
          "  exec: async ({ input }) => ({",
          "    value: input.proceed ? decorate(\"frozen\") : \"blocked\",",
          "  }),",
          "});",
          "",
        ].join("\n"));
        await writeFile(join(externalRoot, "shared", "helper.ts"), [
          'export const decorate = (value: string) => `${value}-source`;',
          "",
        ].join("\n"));

        const preparation = await tryPrepareWorkflow({
          workspaceDir: workspace,
          source: { kind: "path", entry: join(externalRoot, "workflow", "workflow.ts") },
        });
        if (preparation.isErr()) {
          throw new Error(`External workflow preparation failed: ${JSON.stringify(preparation.error)}`);
        }
        const prepared = preparation.value;
        expect(prepared.source.kind).toBe("snapshot");
        if (prepared.source.kind !== "snapshot") throw new Error("expected snapshot source");
        expect(prepared.sourceBundle!.files.map(file => file.path)).toEqual(expect.arrayContaining([
          expect.stringMatching(/workflow\/workflow\.ts$/),
          expect.stringMatching(/shared\/task\.ts$/),
          expect.stringMatching(/shared\/helper\.ts$/),
        ]));
        expect(prepared.sourceBundle!.files.some(file => file.content.includes(sourceOnlyMarker))).toBe(true);

        await initializeRuntimeStoreForTest(workspace);
        const firstDaemon = await startDaemonLoop(workspace, {
          heartbeatMs: 10,
          idleStopMs: 60_000,
          packageVersion: "test",
        });
        let runId: string;
        try {
          const admission = await requestDaemonAdmitRun(workspace, { prepared, input: {} });
          if (admission.isErr()) throw new Error(admission.error.message);
          runId = admission.value.id;
          await waitUntil(async () => (await getRun(workspace, runId))?.status === "awaiting");
        } finally {
          await firstDaemon.shutdown();
        }
        const snapshotFilesRoot = snapshotPath(workspace, prepared.source.digest);
        await expect(readFile(join(snapshotFilesRoot, prepared.source.entry), "utf8"))
          .resolves.toContain(sourceOnlyMarker);
        if (process.platform !== "win32") {
          await expectSnapshotModes(snapshotFilesRoot, prepared.sourceBundle!.files.map(file => file.path));
        }
        await rm(externalRoot, { recursive: true });

        const secondDaemon = await startDaemonLoop(workspace, {
          heartbeatMs: 10,
          idleStopMs: 60_000,
          packageVersion: "test",
        });
        try {
          const signaled = await requestDaemonControl(workspace, {
            requestId: `snapshot-restart:${runId}`,
            type: "signal",
            runId,
            nodeId: "gate",
            payload: { proceed: true },
          });
          if (signaled.isErr()) throw new Error(signaled.error.message);
          const result = await waitForTerminalRun(workspace, runId);
          expect(result.status).toBe("completed");
          expect(result.run.output).toEqual({ value: "frozen-source" });
        } finally {
          await secondDaemon.shutdown();
        }

        const sourceRow = runtimeRow(
          workspace,
          "SELECT source_json FROM run_inputs WHERE run_id = ?",
          runId,
        );
        if (!sourceRow) throw new Error("expected persisted workflow source");
        const sourceJson = String(sourceRow.source_json);
        expect(JSON.parse(sourceJson)).toEqual(prepared.source);
        const runDir = runtimeRunDir(workspace, runId);
        const [lockJson, irJson] = await Promise.all([
          readFile(join(runDir, "lock.json"), "utf8"),
          readFile(join(runDir, "workflow.ir.json"), "utf8"),
        ]);
        const events = runtimeRows(
          workspace,
          "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY sequence",
          runId,
        ).map(row => JSON.parse(String(row.payload_json)));
        expect(events.length).toBeGreaterThan(0);
        for (const [label, artifact] of [
          ["source_json", JSON.parse(sourceJson)],
          ["lock.json", JSON.parse(lockJson)],
          ["workflow.ir.json", JSON.parse(irJson)],
          ["run event payloads", events],
        ] as const) {
          expectNoSourceLeak(label, artifact, externalRoot, sourceOnlyMarker);
        }
      } finally {
        await rm(externalRoot, { recursive: true, force: true });
      }
    }, { authoringEnvironment: true });
  });
});

function snapshotPath(
  workspace: string,
  sourceDigest: Sha256Digest,
): string {
  return join(
    resolveRuntimeLayout(workspace).sourcesRoot,
    "snapshots",
    sourceDigest.slice("sha256:".length),
    "files",
  );
}

function dirnameOfFiles(filesRoot: string): string {
  return join(filesRoot, "..");
}

async function expectSnapshotModes(filesRoot: string, filePaths: readonly string[]): Promise<void> {
  const directories = new Set([dirnameOfFiles(filesRoot), filesRoot]);
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(join(filesRoot, ...segments.slice(0, length)));
    }
  }
  for (const path of directories) {
    expect((await stat(path)).mode & 0o777, path).toBe(0o700);
  }
  for (const path of [
    join(dirnameOfFiles(filesRoot), "manifest.json"),
    ...filePaths.map(filePath => join(filesRoot, ...filePath.split("/"))),
  ]) {
    expect((await stat(path)).mode & 0o777, path).toBe(0o600);
  }
}

function expectNoSourceLeak(
  label: string,
  artifact: unknown,
  physicalRoot: string,
  sourceOnlyMarker: string,
): void {
  for (const value of collectStrings(artifact)) {
    expect(value, `${label} contains the original physical source path`).not.toContain(physicalRoot);
    expect(value, `${label} contains captured source content`).not.toContain(sourceOnlyMarker);
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...collectStrings(item)]);
}

function updatePersistedSource(
  workspace: string,
  runId: string,
  source: PreparedRunWorkflow["source"],
  sourceGraphDigest: Sha256Digest,
  workflowEntry = source.entry,
): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE run_inputs SET source_json = ? WHERE run_id = ?")
      .run(JSON.stringify(source), runId);
    db.prepare("UPDATE runs SET source_graph_digest = ?, workflow_entry = ? WHERE id = ?")
      .run(sourceGraphDigest, workflowEntry, runId);
  } finally {
    db.close();
  }
}
