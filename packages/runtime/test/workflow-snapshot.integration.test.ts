import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type PreparedRunWorkflow,
  type Sha256Digest,
} from "@acpus/runtime";
import { openRuntimeStore } from "../src/store/store.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { admitRunForTest } from "./support/runtime-store.js";
import {
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  runtimeRow,
  snapshotPreparedWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { withSharedStorageHome } from "./support/storage-workspace.js";

describe.concurrent("runtime workflow snapshots", () => {
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

  it.each([
    { name: "invalid UTF-8", corrupt: invalidUtf8Manifest, message: "invalid manifest" },
    {
      name: "a leading UTF-8 BOM",
      corrupt: (manifest: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifest]),
      message: "failed manifest verification",
    },
  ])("rejects $name in an otherwise canonical snapshot manifest", async ({ corrupt, message }) => {
    await withRuntimeWorkspace("workflow-snapshot-manifest-utf8", async workspace => {
      const base = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const prepared = snapshotPreparedWorkflow(base, [
        { path: "helper-\uFFFD.ts", content: "export const helper = true;\n" },
        { path: "workflow.ts", content: "export default 1;\n" },
      ]);
      const store = await openRuntimeStore(workspace);
      try {
        await admitRunForTest(store, { prepared, cwd: workspace, input: { ready: true } });
        if (prepared.source.kind !== "snapshot") throw new Error("expected snapshot source");
        const manifestPath = join(dirnameOfFiles(snapshotPath(workspace, prepared.source.digest)), "manifest.json");
        const manifest = await readFile(manifestPath);
        await writeFile(manifestPath, corrupt(manifest));

        await expect(store.admitRun({ prepared, cwd: workspace, input: { ready: true } }))
          .rejects.toThrow(message);
        expect(store.listRuns()).toHaveLength(1);
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

function invalidUtf8Manifest(manifest: Buffer): Buffer {
  const replacement = Buffer.from("\uFFFD");
  const offset = manifest.indexOf(replacement);
  if (offset < 0) throw new Error("Snapshot manifest has no replacement character test vector.");
  return Buffer.concat([
    manifest.subarray(0, offset),
    Buffer.from([0xff]),
    manifest.subarray(offset + replacement.length),
  ]);
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
