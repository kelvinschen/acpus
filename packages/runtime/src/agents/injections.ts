import { z } from "@acpus/core/schema";
import type {
  AdmittedWorkflowIR,
  AgentDeclarationIR,
  AgentDefinitionIR,
  WorkflowIR,
} from "@acpus/core/ir";
import * as Result from "effect/Result";
import { stableJsonLine } from "../stable-json.js";
import type {
  AgentPresetCatalog,
  AgentPresetResolutionFailure,
  AgentPresetScope,
  ResolvedAgentPreset,
} from "../acpus-config.js";
import { PreservingStringRecordSchema } from "./string-record-schema.js";

export type AgentDirectInjectionSpec = {
  use?: string;
  command?: string;
  model?: string;
  permissionMode?: "approve-reads" | "approve-all" | "deny-all";
  config?: Record<string, string>;
  cwd?: string;
  env?: Record<string, string>;
};

export type AgentPresetInjectionSpec = {
  preset: string;
};

export type AgentInjectionSpec = AgentDirectInjectionSpec | AgentPresetInjectionSpec;
export type AgentInjectionMap = Record<string, AgentInjectionSpec>;

export type AgentInjectionValidationFailure = {
  type: "agent-injections-invalid";
  reason: "not-object" | "unknown-agent" | "schema";
  message: string;
  agentName?: string;
  path?: string;
};

export type AgentBindingSource =
  | { kind: "workflow" }
  | { kind: "direct" }
  | {
      kind: "preset";
      id: string;
      scope: AgentPresetScope;
    };

export type FrozenAgentBinding = {
  source: AgentBindingSource;
  injection?: AgentDirectInjectionSpec;
};

export type FrozenAgentBindingMap = Record<string, FrozenAgentBinding>;

export type AgentBindingFailure = AgentInjectionValidationFailure
  | AgentPresetResolutionFailure
  | {
      type: "agent-bindings-unresolved";
      agentNames: string[];
      message: string;
    };

export type FinalizedAgentBindings = {
  agents: Record<string, AgentDefinitionIR>;
  bindings: FrozenAgentBindingMap;
};

const AgentDirectInjectionSchema = z.object({
  use: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  model: z.string().optional(),
  permissionMode: z.enum(["approve-reads", "approve-all", "deny-all"]).optional(),
  config: PreservingStringRecordSchema.optional(),
  cwd: z.string().min(1).optional(),
  env: PreservingStringRecordSchema.optional(),
}).strict().refine(value => value.use === undefined || value.command === undefined, {
  message: "must not specify both use and command",
});

const AgentPresetInjectionSchema = z.object({
  preset: z.string().min(1),
}).strict();

const AgentBindingSchema = z.object({
  source: z.union([
    z.object({ kind: z.literal("workflow") }).strict(),
    z.object({ kind: z.literal("direct") }).strict(),
    z.object({
      kind: z.literal("preset"),
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      scope: z.enum(["host", "project", "global"]),
    }).strict(),
  ]),
  injection: AgentDirectInjectionSchema.optional(),
}).strict();

export function parseAgentInjectionMap(
  value: unknown,
  declarations?: Record<string, unknown>,
): AgentInjectionMap {
  return Result.match(tryParseAgentInjectionMap(value, declarations), {
    onSuccess: parsed => parsed,
    onFailure: failure => {
      throw new Error(failure.message);
    },
  });
}

export function tryParseAgentInjectionMap(
  value: unknown,
  declarations?: Record<string, unknown>,
): Result.Result<AgentInjectionMap, AgentInjectionValidationFailure> {
  if (!isPlainRecord(value)) {
    return Result.fail({
      type: "agent-injections-invalid",
      reason: "not-object",
      message: "Agent injections must be a JSON object keyed by declared agent name.",
    });
  }
  if (declarations !== undefined) {
    const unknownAgent = Object.keys(value).sort(codeUnitCompare).find(name => !Object.hasOwn(declarations, name));
    if (unknownAgent !== undefined) {
      return Result.fail({
        type: "agent-injections-invalid",
        reason: "unknown-agent",
        agentName: unknownAgent,
        message: `Agent injection '${unknownAgent}' does not reference a declared agent.`,
      });
    }
  }
  const entries: Array<[string, AgentInjectionSpec]> = [];
  for (const name of Object.keys(value).sort(codeUnitCompare)) {
    const candidate = value[name];
    const schema = isPlainRecord(candidate) && Object.hasOwn(candidate, "preset")
      ? AgentPresetInjectionSchema
      : AgentDirectInjectionSchema;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const firstPath = parsed.error.issues[0]?.path ?? [];
      const path = `$.${[name, ...firstPath].join(".")}`;
      return Result.fail({
        type: "agent-injections-invalid",
        reason: "schema",
        path,
        message: `Agent injections are invalid: ${parsed.error.issues.map(issue => formatIssueAt(name, issue)).join("; ")}`,
      });
    }
    entries.push([name, parsed.data as AgentInjectionSpec]);
  }
  return Result.succeed(Object.fromEntries(entries) as AgentInjectionMap);
}

export function finalizeAgentBindings(input: {
  declarations: Record<string, AgentDeclarationIR>;
  injections?: AgentInjectionMap;
  inherited?: FrozenAgentBindingMap;
  presetCatalog?: AgentPresetCatalog;
}): Result.Result<FinalizedAgentBindings, AgentBindingFailure> {
  return finalizeBindings(input);
}

function finalizeBindings(input: {
  declarations: Record<string, AgentDeclarationIR>;
  injections?: AgentInjectionMap;
  inherited?: FrozenAgentBindingMap;
  presetCatalog?: AgentPresetCatalog;
}): Result.Result<FinalizedAgentBindings, AgentBindingFailure> {
  const parsed = tryParseAgentInjectionMap(input.injections ?? {}, input.declarations);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);

  const presetIds = Object.values(parsed.success)
    .filter(isPresetInjection)
    .map(injection => injection.preset);
  const resolved = resolvePresets(presetIds, input.presetCatalog);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);

  const bindingEntries: Array<[string, FrozenAgentBinding]> = [];
  const agentEntries: Array<[string, AgentDefinitionIR]> = [];
  const unresolved: string[] = [];
  for (const name of Object.keys(input.declarations).sort(codeUnitCompare)) {
    const declaration = input.declarations[name]!;
    const injection = Object.hasOwn(parsed.success, name) ? parsed.success[name] : undefined;
    const inherited = input.inherited !== undefined && Object.hasOwn(input.inherited, name)
      ? input.inherited[name]
      : undefined;
    let binding: FrozenAgentBinding | undefined;

    if (injection !== undefined && isPresetInjection(injection)) {
      binding = bindingFromPreset(resolved.success[injection.preset]!);
    } else if (injection !== undefined) {
      const frozenInjection = mergeDirectInjections(
        declaration,
        inherited?.injection ?? {},
        injection,
      );
      const source: AgentBindingSource = hasIdentity(injection)
        ? { kind: "direct" }
        : inherited?.source ?? { kind: "workflow" };
      binding = {
        source,
        ...(Object.keys(frozenInjection).length === 0 ? {} : { injection: frozenInjection }),
      };
    } else if (inherited !== undefined) {
      const frozenInjection = inherited.injection ?? {};
      binding = {
        source: structuredClone(inherited.source),
        ...(Object.keys(frozenInjection).length === 0
          ? {}
          : { injection: structuredClone(frozenInjection) }),
      };
    } else if (declaration.kind !== "agent_slot") {
      binding = { source: { kind: "workflow" } };
    }

    const effective = binding === undefined
      ? undefined
      : applyDirectInjection(declaration, binding.injection ?? {});
    if (binding === undefined || effective === undefined) {
      unresolved.push(name);
    } else {
      bindingEntries.push([name, binding]);
      agentEntries.push([name, effective]);
    }
  }

  if (unresolved.length > 0) {
    return Result.fail({
      type: "agent-bindings-unresolved",
      agentNames: unresolved,
      message: `Agent bindings are required for: ${unresolved.join(", ")}.`,
    });
  }
  const bindings = Object.fromEntries(bindingEntries) as FrozenAgentBindingMap;
  return Result.succeed({
    agents: Object.fromEntries(agentEntries),
    bindings,
  });
}

export function withAgentBindings(
  ir: WorkflowIR,
  finalized: FinalizedAgentBindings,
): AdmittedWorkflowIR {
  return { ...ir, agents: structuredClone(finalized.agents) };
}

export function parseFrozenAgentBindingMap(value: unknown): FrozenAgentBindingMap {
  if (!isPlainRecord(value)) throw new Error("Frozen Agent bindings must be an object.");
  return Object.fromEntries(Object.keys(value).sort(codeUnitCompare).map(name => [
    name,
    AgentBindingSchema.parse(value[name]) as FrozenAgentBinding,
  ])) as FrozenAgentBindingMap;
}

export function rebuildFrozenAgentBindings(
  declarations: Record<string, AgentDeclarationIR>,
  bindings: FrozenAgentBindingMap,
): FinalizedAgentBindings {
  for (const [name, binding] of Object.entries(bindings)) {
    const injection = binding.injection;
    if ((binding.source.kind === "direct" || binding.source.kind === "preset")
      && (injection === undefined || !hasIdentity(injection))) {
      throw new Error(`Frozen Agent binding '${name}' ${binding.source.kind} source requires a frozen identity.`);
    }
    if (binding.source.kind === "workflow" && injection !== undefined && hasIdentity(injection)) {
      throw new Error(`Frozen Agent binding '${name}' workflow source must not contain a frozen identity.`);
    }
    if (binding.source.kind === "preset" && binding.source.id === "dsh" && binding.source.scope !== "host") {
      throw new Error(`Frozen Agent binding '${name}' uses reserved Preset id 'dsh' outside Host scope.`);
    }
  }
  const rebuilt = finalizeBindings({ declarations, inherited: bindings });
  if (Result.isFailure(rebuilt)) throw new Error(`Frozen Agent bindings are incomplete: ${rebuilt.failure.message}`);
  if (stableJsonLine(rebuilt.success.bindings) !== stableJsonLine(bindings)) {
    throw new Error("Frozen Agent bindings are not canonical for their declarations and injections.");
  }
  return rebuilt.success;
}

export function hasPresetInjections(injections: AgentInjectionMap | undefined): boolean {
  return injections !== undefined && Object.values(injections).some(isPresetInjection);
}

export function unboundAgentNames(declarations: Record<string, AgentDeclarationIR>): string[] {
  return Object.entries(declarations)
    .filter(([, declaration]) => declaration.kind === "agent_slot")
    .map(([name]) => name)
    .sort(codeUnitCompare);
}

function bindingFromPreset(preset: ResolvedAgentPreset): FrozenAgentBinding {
  const injection = directInjectionFromDefinition(preset.definition);
  return {
    source: {
      kind: "preset",
      id: preset.id,
      scope: preset.scope,
    },
    injection,
  };
}

function resolvePresets(
  ids: readonly string[],
  catalog: AgentPresetCatalog | undefined,
): Result.Result<Record<string, ResolvedAgentPreset>, AgentPresetResolutionFailure> {
  if (ids.length === 0) return Result.succeed({});
  if (catalog === undefined) {
    const id = [...ids].sort(codeUnitCompare)[0]!;
    return Result.fail({ type: "agent-preset-not-found", id, message: `Agent Preset '${id}' was not found.` });
  }
  return catalog.resolve(ids);
}

function applyDirectInjection(
  base: AgentDeclarationIR,
  injection: AgentDirectInjectionSpec,
): AgentDefinitionIR | undefined {
  const injectedIdentity = injection.command !== undefined
    ? { kind: "agent_command" as const, value: injection.command }
    : injection.use !== undefined
      ? { kind: "agent_definition" as const, value: injection.use }
      : undefined;
  const baseIdentity = base.kind === "agent_slot"
    ? undefined
    : base.kind === "agent_command"
      ? { kind: "agent_command" as const, value: base.command }
      : { kind: "agent_definition" as const, value: base.use };
  const identity = injectedIdentity ?? baseIdentity;
  if (identity === undefined) return undefined;

  const changedIdentity = injectedIdentity !== undefined && baseIdentity !== undefined
    && (injectedIdentity.kind !== baseIdentity.kind || injectedIdentity.value !== baseIdentity.value);
  const shared = compactUndefined({
    model: injection.model ?? (changedIdentity ? undefined : base.model),
    permissionMode: injection.permissionMode ?? base.permissionMode,
    config: injection.config ?? (changedIdentity ? undefined : base.config),
    cwd: injection.cwd ?? base.cwd,
    env: injection.env ?? base.env,
  });
  return identity.kind === "agent_command"
    ? { kind: "agent_command", command: identity.value, ...shared }
    : { kind: "agent_definition", use: identity.value, ...shared };
}

function mergeDirectInjections(
  declaration: AgentDeclarationIR,
  previous: AgentDirectInjectionSpec,
  incoming: AgentDirectInjectionSpec,
): AgentDirectInjectionSpec {
  const before = effectiveIdentity(declaration, previous);
  const combined = { ...previous, ...incoming };
  const after = effectiveIdentity(declaration, combined);
  const changedIdentity = hasIdentity(incoming) && before !== undefined && after !== undefined
    && (before.kind !== after.kind || before.value !== after.value);
  const merged: Record<string, unknown> = changedIdentity
    ? { ...previous, model: undefined, config: undefined, ...incoming }
    : combined;
  if (incoming.use !== undefined) delete merged.command;
  if (incoming.command !== undefined) delete merged.use;
  return compactUndefined(merged) as AgentDirectInjectionSpec;
}

function effectiveIdentity(
  declaration: AgentDeclarationIR,
  injection: AgentDirectInjectionSpec,
): { kind: "use" | "command"; value: string } | undefined {
  if (injection.command !== undefined) return { kind: "command", value: injection.command };
  if (injection.use !== undefined) return { kind: "use", value: injection.use };
  if (declaration.kind === "agent_command") return { kind: "command", value: declaration.command };
  if (declaration.kind === "agent_definition") return { kind: "use", value: declaration.use };
  return undefined;
}

function directInjectionFromDefinition(definition: AgentDefinitionIR): AgentDirectInjectionSpec {
  return compactUndefined({
    ...(definition.kind === "agent_command" ? { command: definition.command } : { use: definition.use }),
    model: definition.model,
    permissionMode: definition.permissionMode,
    config: definition.config === undefined ? undefined : { ...definition.config },
    cwd: definition.cwd,
    env: definition.env === undefined ? undefined : { ...definition.env },
  });
}

function hasIdentity(injection: AgentDirectInjectionSpec): boolean {
  return injection.use !== undefined || injection.command !== undefined;
}

function isPresetInjection(injection: AgentInjectionSpec): injection is AgentPresetInjectionSpec {
  return "preset" in injection;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function formatIssueAt(name: string, issue: { path: PropertyKey[]; message: string }): string {
  return `$.${[name, ...issue.path].join(".")} ${issue.message}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
