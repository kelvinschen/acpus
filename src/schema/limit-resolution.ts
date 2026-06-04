import { issue, type OrchestratorIssue } from "../errors.js";
import type { Stage, WorkflowSpec } from "./workflow-spec.js";
import { getPath, parseSourcePath } from "../variables/paths.js";

export type LimitValue = number | {
  source: string;
  default?: number;
};

export type ResolvedWorkflowLimits = {
  stageTimeoutMinutes: number;
};

export type ResolvedStageLimits = {
  maxConcurrency?: number;
  maxFanoutItems?: number;
  stageTimeoutMinutes?: number;
};

export class LimitResolutionError extends Error {
  readonly issues: OrchestratorIssue[];

  constructor(issues: OrchestratorIssue[]) {
    super(issues.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
    this.name = "LimitResolutionError";
    this.issues = issues;
  }
}

export function validateLimitSources(spec: WorkflowSpec): OrchestratorIssue[] {
  return collectLimitEntries(spec)
    .map((entry) => validateSource(entry.value, entry.path))
    .filter((entry): entry is OrchestratorIssue => !!entry);
}

export function validateInputSourcedLimits(spec: WorkflowSpec, input: Record<string, unknown>): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  for (const entry of collectLimitEntries(spec)) {
    const resolved = resolveLimitValue(entry.value, input, entry.fallback, entry.path);
    if (!resolved.ok) issues.push(resolved.issue);
  }
  return issues;
}

export function resolveWorkflowLimits(spec: WorkflowSpec, input: Record<string, unknown>): ResolvedWorkflowLimits {
  return {
    stageTimeoutMinutes: resolveLimitValueOrThrow(spec.limits.stageTimeoutMinutes, input, 60, "/limits/stageTimeoutMinutes")
  };
}

export function resolveStageLimits(limits: Stage["limits"] | undefined, input: Record<string, unknown>): ResolvedStageLimits {
  const fanoutLimits = fanoutOnlyLimits(limits);
  return {
    maxConcurrency: resolveOptionalLimitValueOrThrow(fanoutLimits?.maxConcurrency, input, "/limits/maxConcurrency"),
    maxFanoutItems: resolveOptionalLimitValueOrThrow(fanoutLimits?.maxFanoutItems, input, "/limits/maxFanoutItems"),
    stageTimeoutMinutes: resolveOptionalLimitValueOrThrow(limits?.stageTimeoutMinutes, input, "/limits/stageTimeoutMinutes")
  };
}

function fanoutOnlyLimits(limits: Stage["limits"] | undefined): { maxConcurrency?: LimitValue; maxFanoutItems?: LimitValue } | undefined {
  if (!limits) return undefined;
  if ("maxConcurrency" in limits || "maxFanoutItems" in limits) return limits;
  return undefined;
}

export function staticLimitOrDefault(value: LimitValue | undefined, fallback: number): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof value.default === "number") return value.default;
  return fallback;
}

function resolveOptionalLimitValueOrThrow(value: LimitValue | undefined, input: Record<string, unknown>, path: string): number | undefined {
  if (value === undefined) return undefined;
  return resolveLimitValueOrThrow(value, input, undefined, path);
}

function resolveLimitValueOrThrow(value: LimitValue | undefined, input: Record<string, unknown>, fallback: number | undefined, path: string): number {
  const resolved = resolveLimitValue(value, input, fallback, path);
  if (resolved.ok) return resolved.value;
  throw new LimitResolutionError([resolved.issue]);
}

function resolveLimitValue(value: LimitValue | undefined, input: Record<string, unknown>, fallback: number | undefined, path: string): { ok: true; value: number } | { ok: false; issue: OrchestratorIssue } {
  if (value === undefined) {
    if (fallback !== undefined) return { ok: true, value: fallback };
    return { ok: false, issue: missingLimitIssue(path, "Limit value is required.") };
  }
  if (typeof value === "number") return { ok: true, value };
  const sourceIssue = validateSource(value, path);
  if (sourceIssue) return { ok: false, issue: sourceIssue };
  const parsed = parseSourcePath(value.source);
  const sourced = getPath(input, parsed.parts);
  if (sourced === undefined) {
    if (value.default !== undefined) return { ok: true, value: value.default };
    return { ok: false, issue: missingLimitIssue(path, `Input-sourced limit ${value.source} is missing.`) };
  }
  if (isPositiveInteger(sourced)) return { ok: true, value: sourced };
  return {
    ok: false,
    issue: issue({
      code: "INPUT_SCHEMA_INVALID",
      severity: "error",
      path,
      message: `Input-sourced limit ${value.source} must resolve to a positive integer number.`,
      suggestions: ["Provide a positive integer number in workflow input; strings and non-integers are invalid."]
    })
  };
}

function validateSource(value: LimitValue | undefined, path: string): OrchestratorIssue | undefined {
  if (!value || typeof value === "number") return undefined;
  try {
    const parsed = parseSourcePath(value.source);
    if (parsed.root === "input" && parsed.parts.length > 0) return undefined;
  } catch {
    // Fall through to the normalized issue below.
  }
  return issue({
    code: "INPUT_SCHEMA_INVALID",
    severity: "error",
    path,
    message: `Limit source ${value.source} is invalid; only absolute input.* paths are supported.`,
    suggestions: ["Use a source such as input.maxConcurrency."]
  });
}

function missingLimitIssue(path: string, message: string): OrchestratorIssue {
  return issue({
    code: "INPUT_REQUIRED",
    severity: "error",
    path,
    message,
    suggestions: ["Provide the input field or set a binding-level default."]
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function collectLimitEntries(spec: WorkflowSpec): Array<{ value: LimitValue | undefined; fallback?: number; path: string }> {
  const entries: Array<{ value: LimitValue | undefined; fallback?: number; path: string }> = [
    { value: spec.limits.stageTimeoutMinutes, fallback: 60, path: "/limits/stageTimeoutMinutes" }
  ];
  const collectStages = (stages: Stage[], prefix: string): void => {
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      const path = `${prefix}/${index}`;
      entries.push({ value: stage.limits?.stageTimeoutMinutes, path: `${path}/limits/stageTimeoutMinutes` });
      if (stage.kind === "fanout") {
        entries.push({ value: stage.limits?.maxConcurrency, path: `${path}/limits/maxConcurrency` });
        entries.push({ value: stage.limits?.maxFanoutItems, path: `${path}/limits/maxFanoutItems` });
      }
      if (stage.kind === "loop") collectStages(stage.body.stages as Stage[], `${path}/body/stages`);
    }
  };
  collectStages(spec.stages, "/stages");
  return entries.filter((entry) => entry.value !== undefined);
}
