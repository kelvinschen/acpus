import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AcpLaunch, AgentSessionBindingCategory } from "./types.js";

export type AgentSessionBinding = Readonly<{
  launch:
    | Readonly<{ kind: "argv"; argv: readonly [string, ...string[]] }>
    | Readonly<{ kind: "command"; command: string }>;
  cwd: string;
  model: string | null;
  options: Readonly<Record<string, string>>;
}>;

export async function resolveAgentSessionBinding(input: Readonly<{
  launch: AcpLaunch;
  cwd: string;
  configuration: Readonly<{ model: string | null; options: Readonly<Record<string, string>> }>;
}>): Promise<AgentSessionBinding> {
  return {
    launch: input.launch.kind === "command"
      ? { kind: "command", command: input.launch.command }
      : { kind: "argv", argv: [...input.launch.argv] as [string, ...string[]] },
    cwd: await realpath(resolve(input.cwd)),
    model: input.configuration.model,
    options: sortedOptions(input.configuration.options),
  };
}

export function isAgentSessionBinding(value: unknown): value is AgentSessionBinding {
  if (!plainRecord(value) || !exactKeys(value, ["launch", "cwd", "model", "options"])) return false;
  if (!plainRecord(value.launch) || typeof value.cwd !== "string"
    || value.cwd.length === 0 || value.model !== null && typeof value.model !== "string"
    || !plainRecord(value.options) || Object.values(value.options).some(option => typeof option !== "string")) return false;
  if (value.launch.kind === "command") {
    return exactKeys(value.launch, ["kind", "command"])
      && typeof value.launch.command === "string"
      && value.launch.command.trim().length > 0;
  }
  return value.launch.kind === "argv"
    && exactKeys(value.launch, ["kind", "argv"])
    && Array.isArray(value.launch.argv)
    && value.launch.argv.length > 0
    && value.launch.argv.every(argument => typeof argument === "string")
    && Boolean(value.launch.argv[0]?.trim());
}

export function normalizeAgentSessionBinding(binding: AgentSessionBinding): AgentSessionBinding {
  return {
    launch: binding.launch.kind === "command"
      ? { kind: "command", command: binding.launch.command }
      : { kind: "argv", argv: [...binding.launch.argv] as [string, ...string[]] },
    cwd: binding.cwd,
    model: binding.model,
    options: sortedOptions(binding.options),
  };
}

export function agentSessionBindingMismatchCategories(
  actual: AgentSessionBinding,
  expected: AgentSessionBinding,
): AgentSessionBindingCategory[] {
  const categories: AgentSessionBindingCategory[] = [];
  if (!sameLaunch(actual.launch, expected.launch)) categories.push("launch");
  if (actual.cwd !== expected.cwd) categories.push("cwd");
  if (actual.model !== expected.model) categories.push("model");
  if (!sameOptions(actual.options, expected.options)) categories.push("options");
  return categories;
}

function sameLaunch(left: AgentSessionBinding["launch"], right: AgentSessionBinding["launch"]): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "command" && right.kind === "command") return left.command === right.command;
  if (left.kind !== "argv" || right.kind !== "argv" || left.argv.length !== right.argv.length) return false;
  return left.argv.every((argument, index) => argument === right.argv[index]);
}

function sameOptions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort(compareCodeUnits);
  const rightKeys = Object.keys(right).sort(compareCodeUnits);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function sortedOptions(options: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(options).sort(([left], [right]) => compareCodeUnits(left, right)));
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
