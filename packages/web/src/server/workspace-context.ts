import {
  inspectRuntimeStore,
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
    async requireStoreReady(workspaceDir: string): Promise<void> {
      const inspected = await inspectRuntimeStore(workspaceDir);
      if (inspected.isErr()) apiError(500, "runtime_store_unavailable", inspected.error.message);
      if (inspected.value.state === "ready") return;
      apiError(
        inspected.value.state === "unsupported" ? 422 : 409,
        inspected.value.state === "unsupported" ? "runtime_store_unavailable" : "runtime_store_fix_required",
        inspected.value.message,
      );
    },
  };
}

export type WebWorkspaceContext = ReturnType<typeof createWorkspaceContext>;
