import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreparedRunWorkflow } from "../src/store/store.js";
import { openRuntimeStore, type WorkflowSourceRef } from "../src/store/store.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { prepareSyntheticWorkflow, validWorkflow } from "./support/runtime-fixtures.js";
import { withSharedStorageHome } from "./support/storage-workspace.js";

describe("global catalog runtime sources", () => {
  it("publishes one digest-addressed snapshot per workspace and reuses it without live source reads", async () => {
    await withSharedStorageHome("catalog-source", async ({ home, first, second }) => {
      const packageRoot = join(home, "workflows", "global-source");
      const workflowPath = join(packageRoot, "workflow.ts");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(workflowPath, "export const source = 'frozen';\n");
      const digest = await digestDirectory(packageRoot);
      const source: Extract<WorkflowSourceRef, { kind: "global_catalog" }> = {
        kind: "global_catalog",
        name: "global-source",
        digest,
        entry: "workflow.ts",
      };
      const base = await prepareSyntheticWorkflow(first, validWorkflow());
      const prepared = globalPrepared(base, workflowPath, packageRoot, source);

      const firstStore = await openRuntimeStore(first);
      const secondStore = await openRuntimeStore(second);
      try {
        const firstRun = await admitRunForTest(firstStore, { prepared, cwd: first, input: { ready: true } });
        const reusedRun = await admitRunForTest(firstStore, { prepared, cwd: first, input: { ready: true } });
        const secondRun = await admitRunForTest(secondStore, { prepared, cwd: second, input: { ready: true } });
        const firstSnapshot = snapshotPath(first, source);
        const secondSnapshot = snapshotPath(second, source);

        expect(firstSnapshot).not.toBe(secondSnapshot);
        expect(firstStore.getFrozenRun(firstRun.id)?.sourceRoot).toBe(firstSnapshot);
        expect(firstStore.getFrozenRun(reusedRun.id)?.sourceRoot).toBe(firstSnapshot);
        expect(secondStore.getFrozenRun(secondRun.id)?.sourceRoot).toBe(secondSnapshot);
        await expect(readFile(join(firstSnapshot, "workflow.ts"), "utf8"))
          .resolves.toBe("export const source = 'frozen';\n");
        await expect(readFile(join(secondSnapshot, "workflow.ts"), "utf8"))
          .resolves.toBe("export const source = 'frozen';\n");
        expect(firstStore.listWorkflowSources()).toEqual([source, source]);
        expect(secondStore.listWorkflowSources()).toEqual([source]);

        await writeFile(workflowPath, "export const source = 'changed';\n");
        await expect(firstStore.admitRun({ prepared, cwd: first, input: { ready: true } })).rejects.toBeInstanceOf(Error);
        expect(firstStore.listRuns()).toHaveLength(2);
        await expect(readFile(join(firstSnapshot, "workflow.ts"), "utf8"))
          .resolves.toBe("export const source = 'frozen';\n");
      } finally {
        firstStore.close();
        secondStore.close();
      }
    });
  });

  it("rejects a same-path runtime sources-root replacement without publishing into it", async () => {
    await withSharedStorageHome("catalog-source-root-identity", async ({ home, first }) => {
      const packageRoot = join(home, "workflows", "global-source");
      const workflowPath = join(packageRoot, "workflow.ts");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(workflowPath, "export const source = 'frozen';\n");
      const source: Extract<WorkflowSourceRef, { kind: "global_catalog" }> = {
        kind: "global_catalog",
        name: "global-source",
        digest: await digestDirectory(packageRoot),
        entry: "workflow.ts",
      };
      const base = await prepareSyntheticWorkflow(first, validWorkflow());
      const prepared = globalPrepared(base, workflowPath, packageRoot, source);
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
});

function globalPrepared(
  prepared: PreparedRunWorkflow,
  workflowPath: string,
  sourceRoot: string,
  source: Extract<WorkflowSourceRef, { kind: "global_catalog" }>,
): PreparedRunWorkflow {
  return {
    ...prepared,
    workflowPath,
    source,
    sourceRoot,
    lock: {
      ...prepared.lock,
      workflow: {
        ...prepared.lock.workflow,
        source,
      },
    },
  };
}

function snapshotPath(
  workspace: string,
  source: Extract<WorkflowSourceRef, { kind: "global_catalog" }>,
): string {
  return join(resolveRuntimeLayout(workspace).sourcesRoot, "catalog", source.name, source.digest);
}

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  await addToDigest(hash, root, "");
  return hash.digest("hex");
}

async function addToDigest(
  hash: ReturnType<typeof createHash>,
  path: string,
  relativePath: string,
): Promise<void> {
  const item = await stat(path);
  const normalized = relativePath.split(/[\\/]/).filter(Boolean).join("/");
  if (item.isDirectory()) {
    if (normalized) hash.update(`D ${normalized}\n`);
    for (const name of (await readdir(path)).sort()) {
      await addToDigest(hash, join(path, name), join(relativePath, name));
    }
    return;
  }
  if (!item.isFile()) return;
  hash.update(`F ${normalized}\n`);
  hash.update(await readFile(path));
  hash.update("\n");
}
