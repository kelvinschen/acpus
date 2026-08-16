import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("closes a Runtime whose open overlaps pool disposal", async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    const opened = deferred<{
      isErr(): false;
      value: { close(): Promise<void> };
    }>();
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
    opened.resolve({ isErr: () => false, value: { close } });

    await disposed;
    await expect(pending).rejects.toMatchObject({ code: "ACPUS_RUNTIME_CLOSED" });
    expect(close).toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}
