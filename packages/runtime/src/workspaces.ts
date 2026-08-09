import { err, ok, ResultAsync, type Result } from "neverthrow";
import { resolveRuntimeLayout, type RuntimeLayout } from "./runtime-layout.js";
import {
  openExistingRuntimeStoreAtLayout,
  type RunStoreSummary,
} from "./store/store.js";
import { inspectRuntimeGeneration } from "./storage/generation.js";
import {
  discoverWorkspaceShards,
  isWorkspaceKey,
  readWorkspaceShardByKey,
  resolveAvailableWorkspaceLayout,
} from "./workspace-discovery.js";

export type KnownWorkspace = {
  workspaceKey: string;
  canonicalPath: string;
  runCount: number;
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

export async function listKnownWorkspaces(cwd: string): Promise<KnownWorkspaceListing> {
  const current = resolveRuntimeLayout(cwd);
  const discoveries = await discoverWorkspaceShards(current.home);
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
    try {
      const layout = await resolveAvailableWorkspaceLayout(discovery);
      workspaces.push(toKnownWorkspace(layout, await readRunStoreSummary(layout)));
    } catch (error) {
      failures.push({
        workspaceKey: discovery.layout.workspaceKey,
        message: errorMessage(error),
      });
    }
  }

  if (!currentShardFound) {
    workspaces.push({
      workspaceKey: current.workspaceKey,
      canonicalPath: current.canonicalPath,
      runCount: 0,
    });
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
}

export function resolveKnownWorkspace(
  cwd: string,
  workspaceKey: string,
): ResultAsync<{ workspaceKey: string; canonicalPath: string }, WorkspaceResolutionFailure> {
  return new ResultAsync(resolveKnownWorkspaceResult(cwd, workspaceKey));
}

async function resolveKnownWorkspaceResult(
  cwd: string,
  workspaceKey: string,
): Promise<Result<{ workspaceKey: string; canonicalPath: string }, WorkspaceResolutionFailure>> {
  if (!isWorkspaceKey(workspaceKey)) {
    return err({
      type: "workspace-key-invalid",
      workspaceKey,
      message: `Workspace key '${workspaceKey}' is invalid.`,
    });
  }

  const current = resolveRuntimeLayout(cwd);
  const matching = await readWorkspaceShardByKey(current.home, workspaceKey);
  if (!matching) {
    if (workspaceKey === current.workspaceKey) return ok(workspaceResolution(current));
    return err({
      type: "workspace-not-found",
      workspaceKey,
      message: `Workspace '${workspaceKey}' was not found.`,
    });
  }
  if ("failure" in matching) {
    return err({
      type: "workspace-unavailable",
      workspaceKey,
      message: matching.failure.message,
    });
  }
  try {
    const layout = await resolveAvailableWorkspaceLayout(matching);
    return ok(workspaceResolution(layout));
  } catch (error) {
    return err({
      type: "workspace-unavailable",
      workspaceKey,
      message: errorMessage(error),
    });
  }
}

async function readRunStoreSummary(layout: RuntimeLayout): Promise<RunStoreSummary> {
  const generation = await inspectRuntimeGeneration(layout);
  if (generation !== "complete") return { runCount: 0 };
  const store = await openExistingRuntimeStoreAtLayout(layout, true, { immutable: true });
  if (!store) return { runCount: 0 };
  try {
    return store.getRunStoreSummary();
  } finally {
    store.close();
  }
}

function toKnownWorkspace(layout: RuntimeLayout, summary: RunStoreSummary): KnownWorkspace {
  return {
    workspaceKey: layout.workspaceKey,
    canonicalPath: layout.canonicalPath,
    runCount: summary.runCount,
    ...(summary.lastRunUpdatedAt === undefined ? {} : { lastRunUpdatedAt: summary.lastRunUpdatedAt }),
  };
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
