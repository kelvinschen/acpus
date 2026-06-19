import {
  EVENT_NAMES,
  INJECTOR_NAMES,
  type EventName,
  type HookConfig,
  type HookHandler,
  type InjectorName
} from "./hooks.js";

export interface HookValidationIssue {
  group?: "injectors" | "events";
  hookName?: string;
  handlerIndex?: number;
  path?: string;
  message: string;
}

export function validateHookConfigShape(config: unknown): HookValidationIssue[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [{ path: "", message: "hook config must be an object" }];
  }
  const hookConfig = config as HookConfig;
  return [
    ...validateHookGroup(hookConfig.injectors, "injectors", INJECTOR_NAMES),
    ...validateHookGroup(hookConfig.events, "events", EVENT_NAMES)
  ];
}

function validateHookGroup(
  group: Partial<Record<string, unknown[]>> | undefined,
  groupName: "injectors" | "events",
  allowedNames: readonly InjectorName[] | readonly EventName[]
): HookValidationIssue[] {
  const issues: HookValidationIssue[] = [];
  for (const [hookName, handlers] of Object.entries(group ?? {})) {
    if (!allowedNames.includes(hookName as never)) {
      issues.push({ group: groupName, hookName, path: `${groupName}.${hookName}`, message: `unknown hook name '${hookName}' in ${groupName}` });
    }
    if (!Array.isArray(handlers)) {
      issues.push({ group: groupName, hookName, path: `${groupName}.${hookName}`, message: "must be an array" });
      continue;
    }
    handlers.forEach((handler, handlerIndex) => {
      for (const message of validateHookHandler(handler, groupName)) {
        issues.push({ group: groupName, hookName, handlerIndex, path: `${groupName}.${hookName}[${handlerIndex}]`, message });
      }
    });
  }
  return issues;
}

function validateHookHandler(handler: unknown, groupName: "injectors" | "events"): string[] {
  if (!handler || typeof handler !== "object") {
    return ["handler must be an object"];
  }
  const h = handler as HookHandler & { on_failure?: unknown; sync?: unknown; timeout?: unknown; cwd?: unknown; env?: unknown };
  const errors: string[] = [];
  const allowedFields = groupName === "injectors"
    ? new Set(["command", "timeout", "env", "cwd", "on_failure"])
    : new Set(["command", "timeout", "env", "cwd", "sync"]);
  for (const field of Object.keys(h as unknown as Record<string, unknown>)) {
    if (!allowedFields.has(field)) errors.push(`${field} is not supported`);
  }
  if (typeof h.command !== "string" || h.command.length === 0) {
    errors.push("command must be a non-empty string");
  }
  if (h.timeout !== undefined && typeof h.timeout !== "string") errors.push("timeout must be a string");
  if (h.cwd !== undefined && typeof h.cwd !== "string") errors.push("cwd must be a string");
  if (h.env !== undefined && !isStringRecord(h.env)) errors.push("env must be a string map");
  if (groupName === "injectors") {
    if (h.on_failure !== undefined && h.on_failure !== "fail" && h.on_failure !== "skip") {
      errors.push(`on_failure must be "fail" or "skip"`);
    }
    if (h.sync !== undefined) errors.push("sync is supported only on event handlers");
  } else {
    if (h.on_failure !== undefined) errors.push("on_failure is supported only on injector handlers");
    if (h.sync !== undefined && typeof h.sync !== "boolean") errors.push("sync must be boolean");
  }
  return errors;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}
