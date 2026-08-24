import { realpath } from "node:fs/promises";
import {
  openWorkspaceRuntime,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHostDependencies,
  type WorkspaceRuntimeOpenFailure,
} from "@acpus/runtime/host";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { AcpusOperationError } from "./errors.js";

export type RuntimePoolOpenFailure =
  | {
      type: "workspace-unavailable";
      workspace: string;
      message: string;
      cause?: unknown;
    }
  | WorkspaceRuntimeOpenFailure;

export type OpenedWorkspaceRuntime = {
  workspace: string;
  runtime: WorkspaceRuntime;
};

export function makeRuntimePool(
  stateRoot: string,
  dependencies: WorkspaceRuntimeHostDependencies = {},
): Effect.Effect<RuntimePool, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => new RuntimePool(stateRoot, dependencies)),
    pool => pool.close(),
  );
}

export class RuntimePool {
  private readonly runtimes = new Map<
    string,
    Effect.Effect<WorkspaceRuntime, WorkspaceRuntimeOpenFailure>
  >();
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private closed = false;

  constructor(
    private readonly stateRoot: string,
    private readonly dependencies: WorkspaceRuntimeHostDependencies = {},
  ) {}

  open(workspace: string): Effect.Effect<OpenedWorkspaceRuntime, RuntimePoolOpenFailure> {
    const pool = this;
    return Effect.gen(function* () {
      const canonicalWorkspace = yield* Effect.tryPromise({
        try: () => realpath(workspace),
        catch: cause => ({
          type: "workspace-unavailable" as const,
          workspace,
          message: `Acpus workspace '${workspace}' is unavailable. Restore the original path and retry.`,
          cause,
        }),
      });
      const opening = yield* pool.semaphore.withPermit(Effect.gen(function* () {
        pool.ensureOpen();
        const existing = pool.runtimes.get(canonicalWorkspace);
        if (existing !== undefined) return existing;
        let cached!: Effect.Effect<WorkspaceRuntime, WorkspaceRuntimeOpenFailure>;
        cached = yield* Effect.cached(openWorkspaceRuntime({
          workspace: canonicalWorkspace,
          stateRoot: pool.stateRoot,
        }, pool.dependencies).pipe(
          Effect.onExit(exit => Exit.isFailure(exit)
            ? Effect.sync(() => {
                if (pool.runtimes.get(canonicalWorkspace) === cached) pool.runtimes.delete(canonicalWorkspace);
              })
            : Effect.void),
        ));
        pool.runtimes.set(canonicalWorkspace, cached);
        return cached;
      }));
      const runtime = yield* opening;
      pool.ensureOpen("Acpus Runtime pool closed while the workspace was opening.");
      return { workspace: canonicalWorkspace, runtime };
    });
  }

  close(): Effect.Effect<void> {
    const pool = this;
    return pool.semaphore.withPermit(Effect.gen(function* () {
      pool.closed = true;
      const exits = yield* Effect.forEach(
        pool.runtimes.values(),
        opening => Effect.result(opening).pipe(
          Effect.flatMap(opened => Result.isFailure(opened) ? Effect.void : opened.success.close()),
          Effect.exit,
        ),
        { concurrency: "unbounded" },
      );
      pool.runtimes.clear();
      let failure: Cause.Cause<never> | undefined;
      for (const exit of exits) {
        if (Exit.isFailure(exit)) failure = failure === undefined ? exit.cause : Cause.combine(failure, exit.cause);
      }
      if (failure !== undefined) return yield* Effect.failCause(failure);
    }));
  }

  private ensureOpen(message = "Acpus Runtime pool is closed."): void {
    if (!this.closed) return;
    throw new AcpusOperationError(message, "ACPUS_RUNTIME_CLOSED");
  }
}
