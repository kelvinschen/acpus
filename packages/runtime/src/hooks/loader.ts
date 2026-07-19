import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { stableJson } from "../stable-json.js";
import { hookEvents, validateHooksFile, type HookConfig, type HooksFile, type HookSource, type HookValidationError, type LoadedHookConfig } from "./config.js";

export type HookConfigScope = {
  source: HookSource;
  path: string;
  hooks: LoadedHookConfig[];
};

export type HookLoadError =
  | { type: "invalid-json"; source: HookSource; path: string; message: string }
  | { type: "invalid-config"; source: HookSource; path: string; errors: HookValidationError[] }
  | { type: "read-failed"; source: HookSource; path: string; message: string };

export function formatHookLoadError(error: HookLoadError): string {
  if (error.type === "invalid-config") {
    return `Invalid hooks config at ${error.path}: ${error.errors.map(item => `${item.path}: ${item.message}`).join("; ")}`;
  }
  return `Invalid hooks config at ${error.path}: ${error.message}`;
}

export function projectHooksPath(workspaceDir: string): string {
  return join(workspaceDir, ".acpus", "hooks.json");
}

export function globalHooksPath(homeDir = homedir()): string {
  return join(homeDir, ".acpus", "hooks.json");
}

export async function loadHooksConfig(workspaceDir: string, options: { homeDir?: string } = {}): Promise<Result<LoadedHookConfig[], HookLoadError>> {
  const scoped = await loadHooksConfigScopes(workspaceDir, options);
  return scoped.map(scopes => scopes.flatMap(scope => scope.hooks));
}

export async function loadHooksConfigScopes(workspaceDir: string, options: { homeDir?: string } = {}): Promise<Result<HookConfigScope[], HookLoadError>> {
  const project = await loadHooksConfigScope("project", projectHooksPath(workspaceDir));
  if (project.isErr()) return err(project.error);
  const global = await loadHooksConfigScope("global", globalHooksPath(options.homeDir));
  if (global.isErr()) return err(global.error);
  return ok([project.value, global.value]);
}

export async function loadHooksConfigScope(source: HookSource, path: string): Promise<Result<HookConfigScope, HookLoadError>> {
  return loadScope(source, path);
}

function flattenHooksFile(file: HooksFile, source: HookSource, sourcePath: string): LoadedHookConfig[] {
  const hooks: LoadedHookConfig[] = [];
  for (const event of hookEvents) {
    const entries = file[event] ?? [];
    for (const [definitionIndex, entry] of entries.entries()) {
      const definitionHash = hashDefinition(source, sourcePath, event, definitionIndex, entry);
      hooks.push({
        ...entry,
        event,
        source,
        sourcePath,
        definitionIndex,
        definitionHash,
        effectiveId: entry.id ?? `${source}:${event}:${definitionIndex}:${definitionHash.slice(0, 12)}`,
      });
    }
  }
  return hooks;
}

async function loadScope(source: HookSource, path: string): Promise<Result<HookConfigScope, HookLoadError>> {
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return ok({ source, path, hooks: [] });
    return err({ type: "read-failed", source, path, message: error instanceof Error ? error.message : String(error) });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch (error) {
    return err({ type: "invalid-json", source, path, message: error instanceof Error ? error.message : String(error) });
  }

  const validated = validateHooksFile(parsed);
  if (validated.isErr()) return err({ type: "invalid-config", source, path, errors: validated.error });
  return ok({ source, path, hooks: flattenHooksFile(validated.value, source, path) });
}

function hashDefinition(source: HookSource, sourcePath: string, event: string, definitionIndex: number, config: HookConfig): string {
  return createHash("sha256")
    .update(stableJson({ source, sourcePath, event, definitionIndex, config }))
    .digest("hex");
}

function isNotFound(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
