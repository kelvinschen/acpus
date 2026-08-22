import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
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
import { acquireRuntimeReadSessionAtLayout } from "../src/store/service.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
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
      const store = await openRuntimeStoreAdapter(workspace);
      const admitted = await admitRunForTest(store, {
        prepared,
        input: { ready: true },
        cwd: workspace,
      });
      store.close();

      const read = await Effect.runPromise(Effect.result(
        readInspection(workspace, { kind: "run", runId: admitted.id }),
      ));
      expect(Result.isSuccess(read) ? read.success : undefined).toMatchObject({
        kind: "run",
        run: { id: admitted.id, status: "pending" },
      });

      const controller = new AbortController();
      const iterator = Stream.toAsyncIterable(Stream.result(observeInspection(workspace, {
        view: { kind: "run", runId: admitted.id },
        until: "subject-terminal",
        signal: controller.signal,
      })))[Symbol.asyncIterator]();
      const attached = await iterator.next();
      expect(Result.isSuccess(attached.value) ? attached.value.success : undefined).toMatchObject({ kind: "attached" });
      controller.abort();
      expect((await iterator.next()).done).toBe(true);

      const catalog = await Effect.runPromise(listKnownWorkspaces(workspace));
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
      const store = await openRuntimeStoreAdapter(workspace);
      store.close();
      await invalidate(resolveRuntimeLayout(workspace));

      const listed = await Effect.runPromise(Effect.result(listRuns(workspace)));

      expect(Result.isFailure(listed) ? listed.failure : undefined).toMatchObject({
        type: "runtime-store-repair-required",
      });
      expect(lifecycleInspector).not.toHaveBeenCalled();
    });
  });

  it("does not downgrade a frozen-run invariant failure to store unavailable", async () => {
    await withRuntimeWorkspace("runtime-bound-read-invariant", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      const admitted = await admitRunForTest(store, {
        prepared,
        input: { ready: true },
        cwd: workspace,
      });
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      await rm(join(layout.runsRoot, admitted.id, "workflow.ir.json"));

      await expect(Effect.runPromise(Effect.result(getRunVisualizationSnapshot(workspace, admitted.id)))).rejects.toThrow();
    });
  });

  it("rejects a fixed-layout session after the manifest publishes another generation", async () => {
    await withRuntimeWorkspace("runtime-fixed-read-generation", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const manifest = JSON.parse(await readFile(layout.manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(layout.manifestPath, `${JSON.stringify({
        ...manifest,
        activeGenerationId: `gen_${randomUUID()}`,
      }, null, 2)}\n`);

      const session = await Effect.runPromise(Effect.result(Effect.scoped(acquireRuntimeReadSessionAtLayout(layout))));

      expect(Result.isFailure(session) ? session.failure : undefined).toMatchObject({
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
