import { tryParseDurationMs } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";

export const hookEvents = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "run.awaiting",
  "node.started",
  "node.completed",
  "node.failed",
] as const;

export type HookEvent = (typeof hookEvents)[number];
export type HookSource = "project" | "global";

export type HookMatch = {
  workflow?: string;
  nodeId?: string;
  nodeKey?: string;
  kind?: string;
};

export type HookConfig = {
  id?: string;
  match?: HookMatch;
  command: string;
  timeout?: string;
};

export type HooksFile = Partial<Record<HookEvent, HookConfig[]>>;

export type LoadedHookConfig = HookConfig & {
  event: HookEvent;
  source: HookSource;
  sourcePath: string;
  definitionIndex: number;
  definitionHash: string;
  effectiveId: string;
};

export type HookValidationError = {
  path: string;
  message: string;
};

const hookEventSet = new Set<string>(hookEvents);
const allowedHookFields = new Set(["id", "match", "command", "timeout"]);
const allowedMatchFields = new Set(["workflow", "nodeId", "nodeKey", "kind"]);

function isHookEvent(value: string): value is HookEvent {
  return hookEventSet.has(value);
}

export function validateHooksFile(config: unknown): Result<HooksFile, HookValidationError[]> {
  const errors: HookValidationError[] = [];
  if (!isRecord(config)) return err([{ path: "$", message: "Hooks file must be an object." }]);

  const output: HooksFile = {};
  for (const [event, value] of Object.entries(config)) {
    if (event === "hooks") {
      errors.push({ path: "$.hooks", message: "Hooks file must be an event map, not a hooks wrapper." });
      continue;
    }
    if (!isHookEvent(event)) {
      errors.push({ path: `$.${event}`, message: `Unknown hook event '${event}'.` });
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push({ path: `$.${event}`, message: "Hook event value must be an array." });
      continue;
    }
    const entries: HookConfig[] = [];
    for (const [index, entry] of value.entries()) {
      const parsed = validateHookEntry(entry, event, `$.${event}[${index}]`, errors);
      if (parsed) entries.push(parsed);
    }
    output[event] = entries;
  }

  return errors.length > 0 ? err(errors) : ok(output);
}

function validateHookEntry(entry: unknown, event: HookEvent, path: string, errors: HookValidationError[]): HookConfig | undefined {
  if (!isRecord(entry)) {
    errors.push({ path, message: "Hook entry must be an object." });
    return undefined;
  }

  for (const key of Object.keys(entry)) {
    if (!allowedHookFields.has(key)) errors.push({ path: `${path}.${key}`, message: `Unknown hook field '${key}'.` });
  }

  const id = entry.id;
  if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
    errors.push({ path: `${path}.id`, message: "Hook id must be a non-empty string." });
  }

  if (typeof entry.command !== "string" || entry.command.length === 0 || entry.command.includes("\0")) {
    errors.push({ path: `${path}.command`, message: "Hook command must be a non-empty string without NUL bytes." });
  }

  const timeout = entry.timeout;
  if (timeout !== undefined && (typeof timeout !== "string" || tryParseDurationMs(timeout).isErr())) {
    errors.push({ path: `${path}.timeout`, message: "Hook timeout must be a duration such as 500ms, 30s, 5m, or 1h." });
  }

  const match = validateMatch(entry.match, event, `${path}.match`, errors);
  if (errors.some(error => error.path === `${path}.command`)) return undefined;

  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(match === undefined ? {} : { match }),
    command: String(entry.command),
    ...(typeof timeout === "string" ? { timeout } : {}),
  };
}

function validateMatch(match: unknown, event: HookEvent, path: string, errors: HookValidationError[]): HookMatch | undefined {
  if (match === undefined) return undefined;
  if (!isRecord(match)) {
    errors.push({ path, message: "Hook match must be an object." });
    return undefined;
  }

  const output: HookMatch = {};
  for (const [key, value] of Object.entries(match)) {
    if (!allowedMatchFields.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown hook match field '${key}'.` });
      continue;
    }
    if (event.startsWith("run.") && event !== "run.awaiting" && key !== "workflow") {
      errors.push({ path: `${path}.${key}`, message: `Match field '${key}' is not valid for ${event}.` });
      continue;
    }
    if (typeof value !== "string") {
      errors.push({ path: `${path}.${key}`, message: "Hook match value must be a regex string." });
      continue;
    }
    try {
      new RegExp(value);
    } catch (error) {
      errors.push({ path: `${path}.${key}`, message: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    output[key as keyof HookMatch] = value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
