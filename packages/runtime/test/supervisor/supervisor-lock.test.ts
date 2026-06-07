import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSupervisorLock } from "../../src/supervisor-lock.js";

describe("acquireSupervisorLock", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("acquires and releases the lock", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-lock-test-"));
    const release = await acquireSupervisorLock(tmpDir);

    // Lock directory should exist while held
    const lockPath = join(tmpDir, "supervisor.lock");
    expect(() => statSync(lockPath)).not.toThrow();

    await release();

    // Lock directory should be removed after release
    expect(() => statSync(lockPath)).toThrow();
  });

  it("serializes concurrent acquisition — second caller waits for first to release", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-lock-test-"));

    const release1 = await acquireSupervisorLock(tmpDir);

    let secondAcquired = false;
    const acquire2Promise = acquireSupervisorLock(tmpDir).then(async (release2) => {
      secondAcquired = true;
      await release2();
    });

    // Give the second acquire a moment to start trying
    await new Promise((r) => setTimeout(r, 100));
    expect(secondAcquired).toBe(false);

    // Release the first lock — the second should now acquire
    await release1();
    await acquire2Promise;
    expect(secondAcquired).toBe(true);
  });

  it("cleans up stale locks and acquires successfully", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-lock-test-"));
    const lockPath = join(tmpDir, "supervisor.lock");

    // Create a stale lock directory manually with old mtime
    mkdirSync(lockPath);
    const staleTime = new Date(Date.now() - 30_000); // 30s ago, exceeds stale threshold
    utimesSync(lockPath, staleTime, staleTime);

    // Should be able to acquire despite stale lock existing
    const release = await acquireSupervisorLock(tmpDir);
    expect(() => statSync(lockPath)).not.toThrow();
    await release();
  });

  it("migrates old file-based lock to directory lock", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acpus-lock-test-"));
    const lockPath = join(tmpDir, "supervisor.lock");

    // Create a plain file at the lock path (old format)
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, timestamp: Date.now() }), "utf8");
    expect(statSync(lockPath).isFile()).toBe(true);

    // Acquiring should remove the file and create a directory lock
    const release = await acquireSupervisorLock(tmpDir);
    expect(statSync(lockPath).isDirectory()).toBe(true);
    await release();
  });

  it("creates stateDir if it does not exist", async () => {
    const baseTmp = mkdtempSync(join(tmpdir(), "acpus-lock-test-"));
    tmpDir = baseTmp; // cleaned up in afterEach
    const stateDir = join(baseTmp, "nested", "state");

    // stateDir doesn't exist yet
    expect(() => statSync(stateDir)).toThrow();

    const release = await acquireSupervisorLock(stateDir);
    expect(() => statSync(stateDir)).not.toThrow();
    expect(statSync(join(stateDir, "supervisor.lock")).isDirectory()).toBe(true);
    await release();
  });
});
