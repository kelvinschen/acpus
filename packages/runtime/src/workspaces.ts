import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { resolveRuntimeWorkspaceLayout, type RuntimeLayout } from "./runtime-layout.js";
import {
  type RunStoreSummary,
} from "./store/store.js";
import { acquireBoundRuntimeReadSession } from "./store/service.js";
import {
  discoverWorkspaceShards,
  isWorkspaceKey,
  readWorkspaceShardByKey,
  resolveAvailableWorkspaceLayout,
} from "./workspace-discovery.js";

export type KnownWorkspace = {
  workspaceKey: string;
  canonicalPath: string;
  runCount?: number;
  lastRunUpdatedAt?: string;
};

export type KnownWorkspaceListing = {
  currentWorkspaceKey: string;
  workspaces: KnownWorkspace[];
  failures: Array<{ workspaceKey: string; message: string }>;
};

export type WorkspaceKeyInvalid = {
  type: "workspace-key-invalid";
  workspaceKey: string;
  message: string;
};

export type WorkspaceNotFound = {
  type: "workspace-not-found";
  workspaceKey: string;
  message: string;
};

export type WorkspaceUnavailable = {
  type: "workspace-unavailable";
  workspaceKey: string;
  message: string;
};

export type WorkspaceResolutionFailure =
  | WorkspaceKeyInvalid
  | WorkspaceNotFound
  | WorkspaceUnavailable;

export function listKnownWorkspaces(cwd: string): Effect.Effect<KnownWorkspaceListing> {
  return Effect.gen(function* () {
    const current = resolveRuntimeWorkspaceLayout(cwd);
    const discoveries = yield* Effect.promise(() => discoverWorkspaceShards(current.home));
    const workspaces: KnownWorkspace[] = [];
    const failures: KnownWorkspaceListing["failures"] = [];
    let currentShardFound = false;

    for (const discovery of discoveries) {
      if ("failure" in discovery) {
        if (discovery.failure.workspaceKey === current.workspaceKey) currentShardFound = true;
        failures.push(discovery.failure);
        continue;
      }
      if (discovery.layout.workspaceKey === current.workspaceKey) currentShardFound = true;
      const workspace = yield* Effect.result(
        Effect.tryPromise({
          try: () => resolveAvailableWorkspaceLayout(discovery),
          catch: errorMessage,
        }).pipe(Effect.flatMap(toKnownWorkspace)),
      );
      if (Result.isSuccess(workspace)) workspaces.push(workspace.success);
      else failures.push({ workspaceKey: discovery.layout.workspaceKey, message: workspace.failure });
    }

    if (!workspaces.some(workspace => workspace.workspaceKey === current.workspaceKey)) {
      const workspace = yield* Effect.result(toKnownWorkspace(current));
      if (Result.isSuccess(workspace)) workspaces.push(workspace.success);
      else {
        workspaces.push({
          workspaceKey: current.workspaceKey,
          canonicalPath: current.canonicalPath,
        });
        if (!currentShardFound) failures.push({
          workspaceKey: current.workspaceKey,
          message: workspace.failure,
        });
      }
    }
    workspaces.sort((left, right) => left.workspaceKey === current.workspaceKey
      ? -1
      : right.workspaceKey === current.workspaceKey
        ? 1
        : left.workspaceKey.localeCompare(right.workspaceKey));
    return {
      currentWorkspaceKey: current.workspaceKey,
      workspaces,
      failures,
    };
  });
}

export function resolveKnownWorkspace(
  cwd: string,
  workspaceKey: string,
): Effect.Effect<{ workspaceKey: string; canonicalPath: string }, WorkspaceResolutionFailure> {
  return Effect.promise(() => resolveKnownWorkspaceResult(cwd, workspaceKey)).pipe(Effect.flatMap(Effect.fromResult));
}

async function resolveKnownWorkspaceResult(
  cwd: string,
  workspaceKey: string,
): Promise<Result.Result<{ workspaceKey: string; canonicalPath: string }, WorkspaceResolutionFailure>> {
  if (!isWorkspaceKey(workspaceKey)) {
    return Result.fail({
      type: "workspace-key-invalid",
      workspaceKey,
      message: `Workspace key '${workspaceKey}' is invalid.`,
    });
  }

  const current = resolveRuntimeWorkspaceLayout(cwd);
  const matching = await readWorkspaceShardByKey(current.home, workspaceKey);
  if (!matching) {
    if (workspaceKey === current.workspaceKey) return Result.succeed(workspaceResolution(current));
    return Result.fail({
      type: "workspace-not-found",
      workspaceKey,
      message: `Workspace '${workspaceKey}' was not found.`,
    });
  }
  if ("failure" in matching) {
    if (workspaceKey === current.workspaceKey) return Result.succeed(workspaceResolution(current));
    return Result.fail({
      type: "workspace-unavailable",
      workspaceKey,
      message: matching.failure.message,
    });
  }
  try {
    const layout = await resolveAvailableWorkspaceLayout(matching);
    return Result.succeed(workspaceResolution(layout));
  } catch (error) {
    return Result.fail({
      type: "workspace-unavailable",
      workspaceKey,
      message: errorMessage(error),
    });
  }
}

type RunStoreSummaryRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ready"; summary: RunStoreSummary };

function readRunStoreSummary(layout: RuntimeLayout): Effect.Effect<RunStoreSummaryRead, string> {
  return Effect.scoped(Effect.gen(function* () {
    const opened = yield* Effect.result(acquireBoundRuntimeReadSession(layout.canonicalPath));
    if (Result.isFailure(opened)) {
      if (opened.failure.type === "runtime-store-unavailable") {
        return yield* Effect.fail(opened.failure.message);
      }
      return { kind: "unavailable" } as const;
    }
    if (!opened.success) return { kind: "absent" } as const;
    const summary = yield* opened.success.store.getRunStoreSummary().pipe(
      Effect.mapError(failure => failure.message),
    );
    return { kind: "ready", summary } as const;
  }));
}

function toKnownWorkspace(layout: RuntimeLayout): Effect.Effect<KnownWorkspace, string> {
  return Effect.map(readRunStoreSummary(layout), read => {
    const summary = read.kind === "ready" ? read.summary : undefined;
    return {
      workspaceKey: layout.workspaceKey,
      canonicalPath: layout.canonicalPath,
      ...(read.kind === "unavailable" ? {} : { runCount: summary?.runCount ?? 0 }),
      ...(summary?.lastRunUpdatedAt === undefined ? {} : { lastRunUpdatedAt: summary.lastRunUpdatedAt }),
    };
  });
}

function workspaceResolution(layout: RuntimeLayout): { workspaceKey: string; canonicalPath: string } {
  return {
    workspaceKey: layout.workspaceKey,
    canonicalPath: layout.canonicalPath,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
