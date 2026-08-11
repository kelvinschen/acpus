import { err, ok, ResultAsync, type Result } from "neverthrow";
import { resolveRuntimeWorkspaceLayout, type RuntimeLayout } from "./runtime-layout.js";
import {
  openBoundRuntimeReadSession,
  type RunStoreSummary,
} from "./store/store.js";
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

export async function listKnownWorkspaces(cwd: string): Promise<KnownWorkspaceListing> {
  const current = resolveRuntimeWorkspaceLayout(cwd);
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
      workspaces.push(await toKnownWorkspace(layout));
    } catch (error) {
      failures.push({
        workspaceKey: discovery.layout.workspaceKey,
        message: errorMessage(error),
      });
    }
  }

  if (!workspaces.some(workspace => workspace.workspaceKey === current.workspaceKey)) {
    try {
      workspaces.push(await toKnownWorkspace(current));
    } catch (error) {
      workspaces.push({
        workspaceKey: current.workspaceKey,
        canonicalPath: current.canonicalPath,
      });
      if (!currentShardFound) failures.push({
        workspaceKey: current.workspaceKey,
        message: errorMessage(error),
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

  const current = resolveRuntimeWorkspaceLayout(cwd);
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
    if (workspaceKey === current.workspaceKey) return ok(workspaceResolution(current));
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

type RunStoreSummaryRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ready"; summary: RunStoreSummary };

async function readRunStoreSummary(layout: RuntimeLayout): Promise<RunStoreSummaryRead> {
  const session = await openBoundRuntimeReadSession(layout.canonicalPath);
  if (session.isErr()) {
    if (session.error.type === "runtime-store-unavailable") throw new Error(session.error.message);
    return { kind: "unavailable" };
  }
  if (!session.value) return { kind: "absent" };
  try {
    return { kind: "ready", summary: session.value.store.getRunStoreSummary() };
  } finally {
    session.value.close();
  }
}

async function toKnownWorkspace(layout: RuntimeLayout): Promise<KnownWorkspace> {
  const read = await readRunStoreSummary(layout);
  const summary = read.kind === "ready" ? read.summary : undefined;
  return {
    workspaceKey: layout.workspaceKey,
    canonicalPath: layout.canonicalPath,
    ...(read.kind === "unavailable" ? {} : { runCount: summary?.runCount ?? 0 }),
    ...(summary?.lastRunUpdatedAt === undefined ? {} : { lastRunUpdatedAt: summary.lastRunUpdatedAt }),
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
