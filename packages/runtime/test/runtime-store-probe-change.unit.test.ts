import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

const probeChanges = vi.hoisted(() => ({
  remaining: Number.POSITIVE_INFINITY,
  calls: 0,
  failOnCall: undefined as number | undefined,
}));

vi.mock("../src/storage/database.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/storage/database.js")>();
  return {
    ...actual,
    readRuntimeDatabaseFormat: async (path: string) => {
      probeChanges.calls += 1;
      if (probeChanges.calls === probeChanges.failOnCall) throw new Error("post-publish validation failed");
      if (probeChanges.remaining > 0) {
        probeChanges.remaining -= 1;
        throw new actual.RuntimeDatabaseProbeChangedError(path, `${path}-wal`);
      }
      return actual.readRuntimeDatabaseFormat(path);
    },
  };
});

import {
  inspectRuntimeStore,
  inspectRuntimeStoreInternal,
  repairRuntimeStore,
} from "../src/runtime-store-lifecycle.js";
import { resolveRuntimeLayout, resolveRuntimeWorkspaceLayout } from "../src/runtime-layout.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";

describe("Runtime database probe changes", () => {
  it("classifies a changing WAL probe as busy instead of unsupported", async () => {
    probeChanges.remaining = Number.POSITIVE_INFINITY;
    probeChanges.calls = 0;
    probeChanges.failOnCall = undefined;
    await withStorageWorkspace("runtime-probe-change", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      store.close();

      expect(Result.getOrThrow(Result.flip((await Effect.runPromise(inspectRuntimeStoreInternal(workspace)))))).toMatchObject({
        type: "inspect-failed",
        reason: "busy",
      });
      expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(inspectRuntimeStore(workspace))))))).toEqual({
        type: "busy",
        message: expect.stringContaining("changed while"),
      });
      expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(repairRuntimeStore(workspace))))))).toEqual({
        type: "busy",
        message: expect.stringContaining("changed while"),
      });
    });
  });

  it("retires a v3 daemon before retrying an inconclusive online probe offline", async () => {
    await withStorageWorkspace("runtime-probe-change-v3", async workspace => {
      await createLegacyStore(workspace, 8);
      const predecessor = await startPredecessorDaemon(workspace);
      probeChanges.remaining = 1;
      probeChanges.calls = 0;
      probeChanges.failOnCall = undefined;
      try {
        expect(Result.getOrThrow((await Effect.runPromise(Effect.result(repairRuntimeStore(workspace)))))).toEqual({ changed: true });
        expect(predecessor.shutdownRequests()).toBe(1);
      } finally {
        await predecessor.close();
      }
    });
  });

  it("preserves a published transition intent until validation succeeds", async () => {
    await withStorageWorkspace("runtime-post-publish-validation", async workspace => {
      await createLegacyStore(workspace, 8);
      const layout = resolveRuntimeWorkspaceLayout(workspace);
      probeChanges.remaining = 0;
      probeChanges.calls = 0;
      probeChanges.failOnCall = 5;

      expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(repairRuntimeStore(workspace))))))).toMatchObject({ type: "failed" });
      await expect(access(layout.transitionJournalPath)).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(layout.manifestPath, "utf8"))).toMatchObject({ manifestVersion: 2 });

      probeChanges.calls = 0;
      probeChanges.failOnCall = undefined;
      expect(Result.getOrThrow((await Effect.runPromise(Effect.result(repairRuntimeStore(workspace)))))).toEqual({ changed: true });
      await expect(access(layout.transitionJournalPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

async function createLegacyStore(workspace: string, storageVersion: number): Promise<void> {
  const store = await openRuntimeStoreAdapter(workspace);
  store.close();
  const current = resolveRuntimeLayout(workspace);
  const database = new DatabaseSync(current.databasePath);
  try {
    database.exec(`PRAGMA user_version = ${storageVersion}; PRAGMA wal_checkpoint(TRUNCATE)`);
  } finally {
    database.close();
  }
  const workspaceLayout = resolveRuntimeWorkspaceLayout(workspace);
  const manifest = JSON.parse(await readFile(current.manifestPath, "utf8")) as Record<string, unknown>;
  await rename(current.runtimeRoot, workspaceLayout.legacyRuntimeRoot);
  await rm(workspaceLayout.generationsRoot, { recursive: true, force: true });
  await writeFile(workspaceLayout.manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    workspaceKey: manifest.workspaceKey,
    canonicalPath: manifest.canonicalPath,
    platform: manifest.platform,
    createdAt: manifest.createdAt,
  }, null, 2)}\n`);
}

async function startPredecessorDaemon(workspace: string): Promise<{
  shutdownRequests(): number;
  close(): Promise<void>;
}> {
  let shutdownRequests = 0;
  const server = createServer({ allowHalfOpen: true }, socket => {
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: unknown };
      if (request.method === "status") {
        socket.end(JSON.stringify({
          ok: true,
          result: {
            status: "ok",
            pid: process.pid,
            generation: 1,
            protocolVersion: 3,
            packageVersion: "0.15.0-test",
          },
        }));
        return;
      }
      shutdownRequests += 1;
      socket.end(JSON.stringify({ ok: true, result: { status: "shutdown" } }), () => server.close());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(resolveRuntimeWorkspaceLayout(workspace).daemonEndpoint, resolve);
  });
  return {
    shutdownRequests: () => shutdownRequests,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
