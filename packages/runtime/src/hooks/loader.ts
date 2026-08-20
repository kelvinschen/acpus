import { err, ok, type Result } from "neverthrow";
import {
  globalAcpusConfigPath,
  loadAcpusConfigScope,
  projectAcpusConfigPath,
} from "../acpus-config.js";
import { hookEvents, type HooksFile, type HookSource, type HookValidationError, type LoadedHookConfig } from "./config.js";

export type HookConfigScope = {
  source: HookSource;
  path: string;
  hooks: LoadedHookConfig[];
};

export type HookLoadError =
  | { type: "invalid-config"; source: HookSource; path: string; errors: HookValidationError[] }
  | { type: "read-failed"; source: HookSource; path: string; message: string };

export function formatHookLoadError(error: HookLoadError): string {
  if (error.type === "invalid-config") {
    return `Invalid Acpus config at ${error.path}: ${error.errors.map(item => `${item.path}: ${item.message}`).join("; ")}`;
  }
  return `Invalid Acpus config at ${error.path}: ${error.message}`;
}

export async function loadHooksConfig(workspaceDir: string, options: { homeDir?: string } = {}): Promise<Result<LoadedHookConfig[], HookLoadError>> {
  const scoped = await loadHooksConfigScopes(workspaceDir, options);
  return scoped.map(scopes => scopes.flatMap(scope => scope.hooks));
}

export async function loadHooksConfigScopes(workspaceDir: string, options: { homeDir?: string } = {}): Promise<Result<HookConfigScope[], HookLoadError>> {
  const project = await loadHooksConfigScope("project", { workspaceDir });
  if (project.isErr()) return err(project.error);
  const global = await loadHooksConfigScope("global", options);
  if (global.isErr()) return err(global.error);
  return ok([project.value, global.value]);
}

export async function loadHooksConfigScope(
  source: HookSource,
  options: { workspaceDir?: string; homeDir?: string },
): Promise<Result<HookConfigScope, HookLoadError>> {
  const path = source === "project"
    ? projectAcpusConfigPath(options.workspaceDir ?? "")
    : globalAcpusConfigPath(options.homeDir);
  const loaded = await loadAcpusConfigScope({
    scope: source,
    ...(options.workspaceDir === undefined ? {} : { workspaceDir: options.workspaceDir }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  if (loaded.isErr()) {
    return err(loaded.error.type === "acpus-config-read-failed"
      ? { type: "read-failed", source, path: loaded.error.path, message: loaded.error.message }
      : {
          type: "invalid-config",
          source,
          path: loaded.error.path,
          errors: [{ path: "$", message: loaded.error.message }],
        });
  }
  return ok({ source, path, hooks: flattenHooksFile(loaded.value.hooks, source, path) });
}

function flattenHooksFile(file: HooksFile, source: HookSource, sourcePath: string): LoadedHookConfig[] {
  const hooks: LoadedHookConfig[] = [];
  for (const event of hookEvents) {
    const entries = file[event] ?? [];
    for (const [definitionIndex, entry] of entries.entries()) {
      hooks.push({
        ...entry,
        event,
        source,
        sourcePath,
        definitionIndex,
        effectiveId: entry.id ?? `${source}:${event}:${definitionIndex}`,
      });
    }
  }
  return hooks;
}
