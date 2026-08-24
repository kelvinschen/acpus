import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  globalAcpusConfigPath,
  loadAcpusConfigScopeResult,
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

export function loadHooksConfig(workspaceDir: string, options: { homeDir?: string } = {}): Effect.Effect<LoadedHookConfig[], HookLoadError> {
  return Effect.promise(() => loadHooksConfigResult(workspaceDir, options)).pipe(Effect.flatMap(Effect.fromResult));
}

export function loadHooksConfigScopes(workspaceDir: string, options: { homeDir?: string } = {}): Effect.Effect<HookConfigScope[], HookLoadError> {
  return Effect.promise(() => loadHooksConfigScopesResult(workspaceDir, options)).pipe(Effect.flatMap(Effect.fromResult));
}

export function loadHooksConfigScope(
  source: HookSource,
  options: { workspaceDir?: string; homeDir?: string },
): Effect.Effect<HookConfigScope, HookLoadError> {
  return Effect.promise(() => loadHooksConfigScopeResult(source, options)).pipe(Effect.flatMap(Effect.fromResult));
}

export async function loadHooksConfigResult(
  workspaceDir: string,
  options: { homeDir?: string } = {},
): Promise<Result.Result<LoadedHookConfig[], HookLoadError>> {
  return Result.map(await loadHooksConfigScopesResult(workspaceDir, options), scopes => scopes.flatMap(scope => scope.hooks));
}

async function loadHooksConfigScopesResult(
  workspaceDir: string,
  options: { homeDir?: string } = {},
): Promise<Result.Result<HookConfigScope[], HookLoadError>> {
  const project = await loadHooksConfigScopeResult("project", { workspaceDir });
  if (Result.isFailure(project)) return Result.fail(project.failure);
  const global = await loadHooksConfigScopeResult("global", options);
  if (Result.isFailure(global)) return Result.fail(global.failure);
  return Result.succeed([project.success, global.success]);
}

async function loadHooksConfigScopeResult(
  source: HookSource,
  options: { workspaceDir?: string; homeDir?: string },
): Promise<Result.Result<HookConfigScope, HookLoadError>> {
  const path = source === "project"
    ? projectAcpusConfigPath(options.workspaceDir ?? "")
    : globalAcpusConfigPath(options.homeDir);
  const loaded = await loadAcpusConfigScopeResult({
    scope: source,
    ...(options.workspaceDir === undefined ? {} : { workspaceDir: options.workspaceDir }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  if (Result.isFailure(loaded)) {
    const error = loaded.failure;
    return Result.fail(error.type === "acpus-config-read-failed"
      ? { type: "read-failed" as const, source, path: error.path, message: error.message }
      : {
          type: "invalid-config" as const,
          source,
          path: error.path,
          errors: [{ path: "$", message: error.message }],
        });
  }
  return Result.succeed({ source, path, hooks: flattenHooksFile(loaded.success.hooks, source, path) });
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
