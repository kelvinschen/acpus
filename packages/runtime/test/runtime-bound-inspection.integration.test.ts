import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const lifecycleInspector = vi.hoisted(() => vi.fn(() => {
  throw new Error("inspection reads must not run lifecycle inspection");
}));

vi.mock("../src/runtime-store-lifecycle.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime-store-lifecycle.js")>(),
  inspectRuntimeStore: lifecycleInspector,
}));

import { observeInspection, readInspection } from "../src/inspection/use-cases.js";
import { getRunVisualizationSnapshot, listRuns } from "../src/runs/use-cases.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeReadSessionAtLayout, openRuntimeStore } from "../src/store/store.js";
import { listKnownWorkspaces } from "../src/workspaces.js";
import { admitRunForTest } from "./support/runtime-store.js";
import {
  prepareSyntheticWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

describe("bound Runtime inspection reads", () => {
  it("reads, attaches, and catalogs without invoking the lifecycle inspector", async () => {
    await withRuntimeWorkspace("runtime-bound-inspection", async workspace => {
      lifecycleInspector.mockClear();
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const admitted = await admitRunForTest(store, {
        prepared,
        input: { ready: true },
        cwd: workspace,
      });
      store.close();

      const read = await readInspection(workspace, { kind: "run", runId: admitted.id });
      expect(read.isOk() ? read.value : undefined).toMatchObject({
        kind: "run",
        run: { id: admitted.id, status: "pending" },
      });

      const controller = new AbortController();
      const iterator = observeInspection(workspace, {
        view: { kind: "run", runId: admitted.id },
        until: "subject-terminal",
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      const attached = await iterator.next();
      expect(attached.value?.isOk() ? attached.value.value : undefined).toMatchObject({ kind: "attached" });
      controller.abort();
      expect((await iterator.next()).done).toBe(true);

      const catalog = await listKnownWorkspaces(workspace);
      expect(catalog.workspaces).toEqual([
        expect.objectContaining({ canonicalPath: workspace, runCount: 1 }),
      ]);
      expect(lifecycleInspector).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["transition intent", async (layout: ReturnType<typeof resolveRuntimeLayout>) => {
      await writeFile(layout.transitionJournalPath, "{}\n");
    }],
    ["generation id", async (layout: ReturnType<typeof resolveRuntimeLayout>) => {
      await rewriteGenerationMetadata(layout, metadata => ({ ...metadata, id: `gen_${randomUUID()}` }));
    }],
    ["storage version", async (layout: ReturnType<typeof resolveRuntimeLayout>) => {
      await rewriteGenerationMetadata(layout, metadata => ({ ...metadata, storageVersion: 8 }));
    }],
    ["sealed marker", async (layout: ReturnType<typeof resolveRuntimeLayout>) => {
      await rewriteGenerationMetadata(layout, metadata => ({
        ...metadata,
        archivedAt: "2026-08-11T00:00:00.000Z",
      }));
    }],
    ["incomplete generation", async (layout: ReturnType<typeof resolveRuntimeLayout>) => {
      await rm(layout.sourcesRoot, { recursive: true });
    }],
  ] as const)("returns repair-required when the active %s is invalid", async (_label, invalidate) => {
    await withRuntimeWorkspace("runtime-bound-read-invalid", async workspace => {
      lifecycleInspector.mockClear();
      const store = await openRuntimeStore(workspace);
      store.close();
      await invalidate(resolveRuntimeLayout(workspace));

      const listed = await listRuns(workspace);

      expect(listed.isErr() ? listed.error : undefined).toMatchObject({
        type: "runtime-store-repair-required",
      });
      expect(lifecycleInspector).not.toHaveBeenCalled();
    });
  });

  it("does not downgrade a frozen-run invariant failure to store unavailable", async () => {
    await withRuntimeWorkspace("runtime-bound-read-invariant", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const admitted = await admitRunForTest(store, {
        prepared,
        input: { ready: true },
        cwd: workspace,
      });
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await rm(join(layout.runsRoot, admitted.id, "workflow.ir.json"));

      await expect(getRunVisualizationSnapshot(workspace, admitted.id)).rejects.toThrow();
    });
  });

  it("rejects a fixed-layout session after the manifest publishes another generation", async () => {
    await withRuntimeWorkspace("runtime-fixed-read-generation", async workspace => {
      const store = await openRuntimeStore(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const manifest = JSON.parse(await readFile(layout.manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(layout.manifestPath, `${JSON.stringify({
        ...manifest,
        activeGenerationId: `gen_${randomUUID()}`,
      }, null, 2)}\n`);

      const session = await openRuntimeReadSessionAtLayout(layout);

      expect(session.isErr() ? session.error : undefined).toMatchObject({
        type: "runtime-store-unavailable",
        message: expect.stringContaining("generation changed"),
      });
    });
  });
});

async function rewriteGenerationMetadata(
  layout: ReturnType<typeof resolveRuntimeLayout>,
  rewrite: (metadata: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const metadata = JSON.parse(await readFile(layout.generationMetadataPath, "utf8")) as Record<string, unknown>;
  await writeFile(layout.generationMetadataPath, `${JSON.stringify(rewrite(metadata), null, 2)}\n`);
}
