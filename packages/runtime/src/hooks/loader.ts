import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EVENT_NAMES,
  INJECTOR_NAMES,
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
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${path}: hook config must be an object`);
  }
  validateGroup(config.injectors, "injectors", path, INJECTOR_NAMES);
  validateGroup(config.events, "events", path, EVENT_NAMES);
}

function validateGroup(
  group: Partial<Record<string, unknown[]>> | undefined,
  groupName: string,
  path: string,
  allowedNames: readonly string[]
): void {
  for (const [hookName, handlers] of Object.entries(group ?? {})) {
    if (!allowedNames.includes(hookName)) {
      throw new Error(`${path}: unknown hook name '${hookName}' in ${groupName}`);
    }
    if (!Array.isArray(handlers)) {
      throw new Error(`${path}: ${groupName}.${hookName} must be an array`);
    }
    handlers.forEach((handler, index) => validateHandler(handler, `${path}: ${groupName}.${hookName}[${index}]`, groupName));
  }
}

function validateHandler(handler: unknown, label: string, groupName: string): void {
  if (!handler || typeof handler !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const h = handler as Record<string, unknown>;
  const allowedFields = groupName === "injectors"
    ? new Set(["command", "timeout", "env", "cwd", "on_failure"])
    : new Set(["command", "timeout", "env", "cwd", "sync"]);
  for (const field of Object.keys(h)) {
    if (!allowedFields.has(field)) {
      throw new Error(`${label}.${field} is not supported`);
    }
  }
  if (typeof h.command !== "string" || h.command.length === 0) {
    throw new Error(`${label}.command must be a non-empty string`);
  }
  if ("timeout" in h && typeof h.timeout !== "string") {
    throw new Error(`${label}.timeout must be a string`);
  }
  if ("cwd" in h && typeof h.cwd !== "string") {
    throw new Error(`${label}.cwd must be a string`);
  }
  if ("env" in h && !isStringRecord(h.env)) {
    throw new Error(`${label}.env must be a string map`);
  }
  if (groupName === "injectors") {
    if ("sync" in h) throw new Error(`${label}.sync is supported only on event handlers`);
    if ("on_failure" in h && h.on_failure !== "fail" && h.on_failure !== "skip") {
      throw new Error(`${label}.on_failure must be "fail" or "skip"`);
    }
  } else {
    if ("on_failure" in h) throw new Error(`${label}.on_failure is supported only on injector handlers`);
    if ("sync" in h && typeof h.sync !== "boolean") {
      throw new Error(`${label}.sync must be boolean`);
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
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
