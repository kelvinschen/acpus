import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";

const runtimeOpen = vi.hoisted(() => vi.fn());

vi.mock("@acpus/runtime/host", () => ({
  openWorkspaceRuntime: runtimeOpen,
}));

import { makeRuntimePool } from "../src/host/runtime-pool.js";

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
    const opened = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pool = yield* makeRuntimePool(join(workspace!, "dsh-runtime"));
      return yield* Effect.result(pool.open(missing));
    })));

    expect(Result.isFailure(opened)).toBe(true);
    if (Result.isSuccess(opened)) throw new Error("Expected a missing workspace failure.");
    expect(opened.failure).toMatchObject({
      type: "workspace-unavailable",
      workspace: missing,
      message: expect.stringContaining("Restore the original path and retry"),
    });
    expect(runtimeOpen).not.toHaveBeenCalled();
  });

  it("closes a Runtime whose open overlaps pool disposal", async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    const opened = Deferred.makeUnsafe<WorkspaceRuntime>();
    const close = vi.fn(() => Effect.succeed(undefined));
    runtimeOpen.mockReturnValue(Deferred.await(opened));
    const stateRoot = join(workspace, "dsh-runtime");
    const dsh = vi.fn(() => [process.execPath, "dsh-agent.js"]);
    const scope = await Effect.runPromise(Scope.make("parallel"));
    const pool = await Effect.runPromise(Scope.provide(scope)(
      makeRuntimePool(stateRoot, { namedAgentLaunches: { dsh } }),
    ));

    const pending = Effect.runPromise(pool.open(workspace));
    await vi.waitFor(() => expect(runtimeOpen).toHaveBeenCalledOnce());
    expect(runtimeOpen).toHaveBeenCalledWith({
      workspace,
      stateRoot,
    }, {
      namedAgentLaunches: { dsh },
    });
    const disposed = Effect.runPromise(Scope.close(scope, Exit.void));
    Deferred.doneUnsafe(opened, Effect.succeed({ close } as unknown as WorkspaceRuntime));

    await disposed;
    await expect(pending).rejects.toMatchObject({ code: "ACPUS_RUNTIME_CLOSED" });
    expect(close).toHaveBeenCalled();
  });

  it.each([
    { type: "runtime-authority-busy", message: "owned elsewhere", pid: 42 },
    { type: "runtime-store-unavailable", message: "store unavailable" },
  ] as const)("returns and does not cache typed $type failures", async failure => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    runtimeOpen.mockReturnValue(Effect.fail(failure));
    const [first, second] = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pool = yield* makeRuntimePool(join(workspace!, "dsh-runtime"));
      return [
        yield* Effect.result(pool.open(workspace!)),
        yield* Effect.result(pool.open(workspace!)),
      ] as const;
    })));

    expect(Result.isFailure(first) && first.failure).toEqual(failure);
    expect(Result.isFailure(second) && second.failure).toEqual(failure);
    expect(runtimeOpen).toHaveBeenCalledTimes(2);
  });

  it("preserves unknown Runtime open exceptions and permits a later retry", async () => {
    workspace = await mkdtemp(join(tmpdir(), "acpus-dsh-runtime-pool-"));
    runtimeOpen.mockReturnValueOnce(Effect.die(new Error("unexpected open failure")));
    runtimeOpen.mockReturnValueOnce(Effect.fail({
      type: "runtime-open-failed",
      message: "typed retry failure",
    }));
    const retry = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pool = yield* makeRuntimePool(join(workspace!, "dsh-runtime"));
      const first = yield* Effect.exit(pool.open(workspace!));
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isSuccess(first)) throw new Error("Expected an open defect.");
      expect(Cause.squash(first.cause)).toEqual(expect.objectContaining({
        message: "unexpected open failure",
      }));
      return yield* Effect.result(pool.open(workspace!));
    })));

    expect(Result.isFailure(retry) && retry.failure.type).toBe("runtime-open-failed");
    expect(runtimeOpen).toHaveBeenCalledTimes(2);
  });
});
