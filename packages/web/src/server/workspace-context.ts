import {
  listKnownWorkspaces,
  resolveKnownWorkspace,
} from "@acpus/runtime";
import { apiError } from "./errors.js";

export function createWorkspaceContext(cwd: string) {
  let launchWorkspaceKey: string | undefined;

  async function list() {
    const listing = await listKnownWorkspaces(cwd);
    launchWorkspaceKey ??= listing.currentWorkspaceKey;
    return listing;
  }

  return {
    list,
    async launchKey(): Promise<string> {
      return launchWorkspaceKey ?? (await list()).currentWorkspaceKey;
    },
    async resolve(workspaceKey: string) {
      const resolved = await resolveKnownWorkspace(cwd, workspaceKey);
      if (resolved.isErr()) {
        apiError(404, "workspace_not_found", `Workspace '${workspaceKey}' was not found.`);
      }
      return resolved.value;
    },
  };
}

export type WebWorkspaceContext = ReturnType<typeof createWorkspaceContext>;
