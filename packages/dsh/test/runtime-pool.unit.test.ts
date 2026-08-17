import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errAsync, ok, type Result } from "neverthrow";
import type { WorkspaceRuntime } from "@acpus/runtime/host";

const runtimeOpen = vi.hoisted(() => vi.fn());

vi.mock("@acpus/runtime/host", () => ({
  openWorkspaceRuntime: runtimeOpen,
}));

import { RuntimePool } from "../src/host/runtime-pool.js";

let workspace: string | undefined;

afterEach(async () => {
  runtimeOpen.mockReset();
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("Acpus Runtime pool lifecycle", () => {
  it("returns a tagged recoverable failure for a missing workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    const missing = join(workspace, "missing");
    const pool = new RuntimePool(join(workspace, "dsh-runtime"));

    const opened = await pool.open(missing);

    expect(opened.isErr()).toBe(true);
    if (opened.isOk()) throw new Error("Expected a missing workspace failure.");
    expect(opened.error).toMatchObject({
      type: "workspace-unavailable",
      workspace: missing,
      message: expect.stringContaining("Restore the original path and retry"),
    });
    expect(runtimeOpen).not.toHaveBeenCalled();
    await pool.close();
  });

  it("closes a Runtime whose open overlaps pool disposal", async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    const opened = deferred<Result<WorkspaceRuntime, never>>();
    const close = vi.fn(async () => undefined);
    runtimeOpen.mockReturnValue(opened.promise);
    const stateRoot = join(workspace, "dsh-runtime");
    const dsh = vi.fn(() => [process.execPath, "dsh-agent.js"]);
    const pool = new RuntimePool(stateRoot, { namedAgentLaunches: { dsh } });

    const pending = pool.open(workspace);
    await vi.waitFor(() => expect(runtimeOpen).toHaveBeenCalledOnce());
    expect(runtimeOpen).toHaveBeenCalledWith({
      workspace,
      stateRoot,
    }, {
      namedAgentLaunches: { dsh },
    });
    const disposed = pool.close();
    opened.resolve(ok({ close } as unknown as WorkspaceRuntime));

    await disposed;
    await expect(pending).rejects.toMatchObject({ code: "ACPUS_RUNTIME_CLOSED" });
    expect(close).toHaveBeenCalled();
  });

  it.each([
    { type: "runtime-authority-busy", message: "owned elsewhere", pid: 42 },
    { type: "runtime-store-unavailable", message: "store unavailable" },
  ] as const)("returns and does not cache typed $type failures", async failure => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    runtimeOpen.mockReturnValue(errAsync(failure));
    const pool = new RuntimePool(join(workspace, "dsh-runtime"));

    const first = await pool.open(workspace);
    const second = await pool.open(workspace);

    expect(first.isErr() && first.error).toEqual(failure);
    expect(second.isErr() && second.error).toEqual(failure);
    expect(runtimeOpen).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("preserves unknown Runtime open exceptions and permits a later retry", async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    runtimeOpen.mockRejectedValueOnce(new Error("unexpected open failure"));
    runtimeOpen.mockReturnValueOnce(errAsync({
      type: "runtime-open-failed",
      message: "typed retry failure",
    }));
    const pool = new RuntimePool(join(workspace, "dsh-runtime"));

    await expect(pool.open(workspace)).rejects.toThrow("unexpected open failure");
    const retry = await pool.open(workspace);

    expect(retry.isErr() && retry.error.type).toBe("runtime-open-failed");
    expect(runtimeOpen).toHaveBeenCalledTimes(2);
    await pool.close();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}
