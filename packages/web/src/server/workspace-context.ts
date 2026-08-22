import {
  listKnownWorkspaces,
  resolveKnownWorkspace,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { apiError } from "./errors.js";

export function createWorkspaceContext(cwd: string) {
  let launchWorkspaceKey: string | undefined;

  async function list() {
    const listing = await Effect.runPromise(listKnownWorkspaces(cwd));
    launchWorkspaceKey ??= listing.currentWorkspaceKey;
    return listing;
  }

  return {
    list,
    async launchKey(): Promise<string> {
      return launchWorkspaceKey ?? (await list()).currentWorkspaceKey;
    },
    async resolve(workspaceKey: string) {
      const resolved = await Effect.runPromise(Effect.result(resolveKnownWorkspace(cwd, workspaceKey)));
      if (Result.isFailure(resolved)) {
        apiError(404, "workspace_not_found", `Workspace '${workspaceKey}' was not found.`);
      }
      return resolved.success;
    },
  };
}

export type WebWorkspaceContext = ReturnType<typeof createWorkspaceContext>;
