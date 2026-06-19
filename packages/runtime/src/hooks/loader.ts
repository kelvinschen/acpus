import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EVENT_NAMES,
  INJECTOR_NAMES,
  validateHookConfigShape,
  type EventHookHandler,
  type EventName,
  type HookConfig,
  type HookConfigSnapshot,
  type InjectorHookHandler,
  type InjectorName
} from "@acpus/core";

/** Absolute path to the global hooks file (~/.acpus/hooks.yaml). */
export function globalHookConfigPath(): string {
  return join(homedir(), ".acpus", "hooks.yaml");
}

/** Absolute path to the project hooks file (<workspace>/.acpus/hooks.yaml). */
export function projectHookConfigPath(workspace: string): string {
  return join(resolve(workspace), ".acpus", "hooks.yaml");
}

/** True when the config declares no injectors and no events. */
export function isEmptyHookConfig(config: HookConfig): boolean {
  const injectorCount = INJECTOR_NAMES.reduce((n, k) => n + (config.injectors?.[k]?.length ?? 0), 0);
  const eventCount = EVENT_NAMES.reduce((n, k) => n + (config.events?.[k]?.length ?? 0), 0);
  return injectorCount === 0 && eventCount === 0;
}

/** A loaded layer, plus its source path when the file existed. */
export interface LoadedLayer {
  path: string;
  config: HookConfig;
  exists: boolean;
}

/**
 * Loads and merges hook configuration from the global and project layers.
 *
 * A missing layer is treated as empty (no error). Merge concatenates handler
 * arrays per key with global handlers ordered before project handlers.
 */
export class HookConfigLoader {
  constructor(private readonly workspace: string = process.cwd()) {}

  /** Read a single layer; absent or empty files yield an empty config. */
  loadLayer(path: string): LoadedLayer {
    if (!existsSync(path)) return { path, config: {}, exists: false };
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return { path, config: {}, exists: true };
    const parsed = parseYaml(raw) as HookConfig;
    validateHookConfig(parsed, path);
    return { path, config: parsed, exists: true };
  }

  /** Load and merge both layers, returning the merged config plus source paths. */
  load(): { merged: HookConfig; globalLayer: LoadedLayer; projectLayer: LoadedLayer } {
    const globalLayer = this.loadLayer(globalHookConfigPath());
    const projectLayer = this.loadLayer(projectHookConfigPath(this.workspace));
    const merged = mergeHookConfigs(globalLayer.config, projectLayer.config);
    return { merged, globalLayer, projectLayer };
  }

  /**
   * Freeze the merged configuration into a snapshot. Returns `undefined` when
   * both layers are absent/empty so the runtime can skip all hook machinery.
   */
  freeze(): HookConfigSnapshot | undefined {
    const { merged, globalLayer, projectLayer } = this.load();
    if (isEmptyHookConfig(merged)) return undefined;
    return {
      hash: hashHookConfig(merged),
      globalConfigPath: globalLayer.exists ? globalLayer.path : undefined,
      projectConfigPath: projectLayer.exists ? projectLayer.path : undefined,
      mergedConfig: merged
    };
  }
}

/** Validate the minimal command-only hook config shape used by the runtime. */
function validateHookConfig(config: HookConfig, path: string): void {
  const [issue] = validateHookConfigShape(config);
  if (!issue) return;
  throw new Error(`${path}: ${issue.path ? `${issue.path} ` : ""}${issue.message}`);
}

/** Concatenate handler arrays per key; global handlers precede project handlers. */
export function mergeHookConfigs(global: HookConfig, project: HookConfig): HookConfig {
  const injectors: Partial<Record<InjectorName, InjectorHookHandler[]>> = {};
  for (const key of INJECTOR_NAMES) {
    const combined = [...(global.injectors?.[key] ?? []), ...(project.injectors?.[key] ?? [])];
    if (combined.length > 0) injectors[key] = combined;
  }
  const events: Partial<Record<EventName, EventHookHandler[]>> = {};
  for (const key of EVENT_NAMES) {
    const combined = [...(global.events?.[key] ?? []), ...(project.events?.[key] ?? [])];
    if (combined.length > 0) events[key] = combined;
  }
  const result: HookConfig = {};
  if (Object.keys(injectors).length > 0) result.injectors = injectors;
  if (Object.keys(events).length > 0) result.events = events;
  return result;
}

/** Stable "sha256:..." hash over the canonicalized merged configuration. */
export function hashHookConfig(config: HookConfig): string {
  return `sha256:${createHash("sha256").update(canonicalJson(config)).digest("hex")}`;
}

/** Deterministic JSON with object keys sorted recursively. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
