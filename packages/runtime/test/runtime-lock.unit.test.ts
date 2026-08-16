import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRuntimeExclusiveLock,
  acquireRuntimeSharedLock,
  RuntimeLockTimeoutError,
  type RuntimeLockDependencies,
} from "../src/runtime-lock.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { withStorageWorkspace } from "./support/storage-workspace.js";

describe("runtime maintenance lock", () => {
  it("allows concurrent runtime users to initialize an absent lock tree", async () => {
    await withStorageWorkspace("runtime-lock-concurrent-init", async workspace => {
      const layout = resolveRuntimeLayout(workspace);

      const locks = await Promise.all([
        acquireRuntimeSharedLock(layout),
        acquireRuntimeSharedLock(layout),
      ]);
      try {
        const holders = join(layout.home, "tmp", "runtime-locks", layout.workspaceKey, "holders");
        expect(await readdir(holders)).toHaveLength(2);
      } finally {
        for (const lock of locks) lock.release();
      }
    });
  });

  it("serializes maintenance owners without using a real polling delay", async () => {
    await withStorageWorkspace("runtime-lock-maintenance", async workspace => {
      const layout = resolveRuntimeLayout(workspace);
      const first = await acquireRuntimeExclusiveLock(layout);
      let released = false;
      const clock = fakeClock(async () => {
        if (released) return;
        released = true;
        await first.release();
      });

      const second = await acquireRuntimeExclusiveLock(layout, clock.dependencies);

      expect(released).toBe(true);
      expect(clock.now()).toBe(25);
      await second.release();
    });
  });

  it("reports runtime users as a distinct blocker with controlled time", async () => {
    await withStorageWorkspace("runtime-lock-users", async workspace => {
      const layout = resolveRuntimeLayout(workspace);
      const shared = await acquireRuntimeSharedLock(layout);
      const clock = fakeClock();
      let failure: unknown;
      try {
        await acquireRuntimeExclusiveLock(layout, clock.dependencies);
      } catch (error) {
        failure = error;
      } finally {
        shared.release();
      }

      expect(failure).toMatchObject({
        name: "RuntimeLockTimeoutError",
        blocker: "runtime users",
      } satisfies Partial<RuntimeLockTimeoutError>);
      expect(clock.now()).toBe(500);
    });
  });

  it.skipIf(process.platform !== "linux")("reclaims a holder whose PID was reused", async () => {
    await withStorageWorkspace("runtime-lock-reused-pid", async workspace => {
      const layout = resolveRuntimeLayout(workspace);
      const shared = await acquireRuntimeSharedLock(layout);
      shared.release();
      const holders = join(layout.home, "tmp", "runtime-locks", layout.workspaceKey, "holders");
      await writeFile(join(holders, "stale.json"), `${JSON.stringify({
        pid: process.pid,
        startToken: "linux:reused",
        token: "stale",
        createdAt: "2026-08-16T00:00:00.000Z",
      })}\n`);

      const exclusive = await acquireRuntimeExclusiveLock(layout);
      try {
        expect(await readdir(holders)).toEqual([]);
      } finally {
        await exclusive.release();
      }
    });
  });

  it.skipIf(process.platform === "win32")("rejects a lock-root symlink before writing through it", async () => {
    await withStorageWorkspace("runtime-lock-symlink", async workspace => {
      const layout = resolveRuntimeLayout(workspace);
      const outside = join(layout.home, "outside");
      await Promise.all([
        mkdir(layout.home, { recursive: true }),
        mkdir(outside, { recursive: true }),
      ]);
      await symlink(outside, join(layout.home, "tmp"), "dir");

      await expect(acquireRuntimeExclusiveLock(layout)).rejects.toBeInstanceOf(Error);
      await expect(readdir(outside)).resolves.toEqual([]);
    });
  });
});

function fakeClock(onWait?: () => Promise<void>): {
  dependencies: RuntimeLockDependencies;
  now(): number;
} {
  let now = 0;
  return {
    dependencies: {
      now: () => now,
      wait: async delayMs => {
        now += delayMs;
        await onWait?.();
      },
    },
    now: () => now,
  };
}
