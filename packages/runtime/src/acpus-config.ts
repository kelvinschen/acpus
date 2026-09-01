import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "@acpus/core/schema";
import type { AgentCommandSpec, AgentUseSpec } from "@acpus/core";
import type { AgentDefinitionIR } from "@acpus/core/ir";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { PreservingStringRecordSchema } from "./agents/string-record-schema.js";
import { validateHooksFile, type HooksFile } from "./hooks/config.js";
import { captureProcessIdentity, probeProcessIdentity } from "./process-liveness.js";
import { writePrivateJsonAtomically } from "./storage/private-json.js";

export type AgentPresetSpec = {
  guidance: string;
  agent: AgentUseSpec | AgentCommandSpec;
};

export type AgentPresetScope = "host" | "project" | "global";
export type WritableAgentPresetScope = Exclude<AgentPresetScope, "host">;

export type HostAgentPreset = AgentPresetSpec & { id: string };

export type AgentPresetProviderFailure = {
  type: "agent-preset-provider-failed";
  message: string;
};

export type AgentPresetProvider = (input: {
  workspaceDir?: string;
}) => Effect.Effect<readonly HostAgentPreset[], AgentPresetProviderFailure>;

export type AgentPresetChoice = {
  id: string;
  guidance: string;
  scope: AgentPresetScope;
};

export type ResolvedAgentPreset = {
  id: string;
  scope: AgentPresetScope;
  definition: AgentDefinitionIR;
};

export type AgentPresetResolutionFailure = {
  type: "agent-preset-not-found";
  id: string;
  message: string;
};

export type AgentPresetCatalog = {
  readonly choices: readonly AgentPresetChoice[];
  resolve(ids: readonly string[]): Result.Result<Record<string, ResolvedAgentPreset>, AgentPresetResolutionFailure>;
};

export const AUTHORING_AGENT_SCALE_ENV = "ACPUS_AUTHORING_AGENT_SCALE";

export type AuthoringAgentScale = number | "small" | "medium" | "large" | "unrestricted";

export type NormalizedAuthoringAgentScale = {
  value: AuthoringAgentScale;
  maxAgentOccurrences?: number;
};

export type EffectiveAuthoringAgentScale = NormalizedAuthoringAgentScale & {
  source: "environment" | WritableAgentPresetScope;
};

export type AgentAuthoringContext = {
  scale?: EffectiveAuthoringAgentScale;
  presets: AgentPresetCatalog;
};

export type AuthoringAgentScaleEnvironmentFailure = {
  type: "authoring-agent-scale-environment-invalid";
  variable: typeof AUTHORING_AGENT_SCALE_ENV;
  value: string;
  message: string;
};

export type AgentAuthoringContextFailure = AgentPresetCatalogFailure | AuthoringAgentScaleEnvironmentFailure;

export type AuthoringAgentScaleWriteFailure = AcpusConfigReadFailure
  | { type: "authoring-agent-scale-scope-invalid"; message: string }
  | { type: "authoring-agent-scale-value-invalid"; message: string }
  | { type: "authoring-agent-scale-busy"; scope: WritableAgentPresetScope; path: string; message: string }
  | { type: "authoring-agent-scale-write-failed"; scope: WritableAgentPresetScope; path: string; message: string };

export type AcpusAuthoringConfig = {
  agentScale?: AuthoringAgentScale;
};

export type AcpusConfig = {
  agents: Record<string, string>;
  presets: Record<string, AgentPresetSpec>;
  authoring: AcpusAuthoringConfig;
  hooks: HooksFile;
};

export type AcpusConfigReadFailure =
  | { type: "acpus-config-invalid"; source: WritableAgentPresetScope; path: string; message: string }
  | { type: "acpus-config-read-failed"; source: WritableAgentPresetScope; path: string; message: string };

export type AgentPresetCatalogFailure =
  | AcpusConfigReadFailure
  | { type: "agent-preset-catalog-invalid"; source: "host"; message: string }
  | { type: "agent-preset-catalog-scope-invalid"; message: string }
  | AgentPresetProviderFailure;

export type AgentPresetChange =
  | { type: "set"; id: string; preset: AgentPresetSpec }
  | { type: "remove"; id: string };

export type AgentPresetWriteFailure = AgentPresetCatalogFailure
  | { type: "agent-preset-changes-invalid"; message: string }
  | { type: "agent-preset-exists"; id: string; message: string }
  | { type: "agent-preset-missing"; id: string; message: string }
  | { type: "agent-preset-busy"; scope: WritableAgentPresetScope; path: string; message: string }
  | { type: "agent-preset-write-failed"; scope: WritableAgentPresetScope; path: string; message: string };

type CatalogEntry = {
  id: string;
  scope: AgentPresetScope;
  guidance: string;
  definition: AgentDefinitionIR;
};

type ConfigFileBoundary = {
  rootPath: string;
  rootRealpath: string;
  rootIdentity: string;
  parentPath: string;
  parentRealpath: string;
  parentIdentity: string;
  path: string;
};

type ConfigLockOwner = {
  pid: number;
  startToken?: string;
  token: string;
};

type ConfigFileLock = {
  release(): Promise<void>;
};

const AgentOptionsSchema = {
  model: z.string().optional(),
  config: PreservingStringRecordSchema.optional(),
  permissionMode: z.enum(["approve-reads", "approve-all", "deny-all"]).optional(),
  cwd: z.string().min(1).optional(),
  env: PreservingStringRecordSchema.optional(),
};

const AgentPresetSpecSchema = z.object({
  guidance: z.string().trim().min(1).max(2_000),
  agent: z.union([
    z.object({
      use: z.string().min(1),
      command: z.never().optional(),
      ...AgentOptionsSchema,
    }).strict(),
    z.object({
      command: z.string().min(1),
      use: z.never().optional(),
      ...AgentOptionsSchema,
    }).strict(),
  ]),
}).strict();

const AuthoringAgentScaleSchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.enum(["small", "medium", "large", "unrestricted"]),
]);

const AcpusAuthoringConfigSchema = z.object({
  agentScale: AuthoringAgentScaleSchema.optional(),
}).strict();

const AcpusConfigFileSchema = z.object({
  agents: z.unknown().optional(),
  presets: z.unknown().optional(),
  authoring: z.unknown().optional(),
  hooks: z.unknown().optional(),
}).strict();

const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_PRESETS_PER_SCOPE = 50;
const RESERVED_PRESET_IDS = new Set(["dsh"]);

export function projectAcpusConfigPath(workspaceDir: string): string {
  return join(resolve(workspaceDir), ".acpus", "config.json");
}

export function globalAcpusConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".acpus", "config.json");
}

export function loadAgentPresetCatalog(input: {
  workspaceDir?: string;
  homeDir?: string;
  hostProvider?: AgentPresetProvider;
  scopes?: readonly AgentPresetScope[];
}): Effect.Effect<AgentPresetCatalog, AgentPresetCatalogFailure> {
  return Effect.gen(function*() {
    const requestedScopes = input.scopes ?? (input.workspaceDir === undefined
      ? ["host", "global"] as const
      : ["host", "project", "global"] as const);
    if (requestedScopes.some(scope => scope !== "host" && scope !== "project" && scope !== "global")) {
      return yield* Effect.fail({
        type: "agent-preset-catalog-scope-invalid" as const,
        message: "Agent Preset catalog scopes must be host, project, or global.",
      });
    }
    if (new Set(requestedScopes).size !== requestedScopes.length) {
      return yield* Effect.fail({
        type: "agent-preset-catalog-scope-invalid" as const,
        message: "Agent Preset catalog scopes must not contain duplicates.",
      });
    }
    if (requestedScopes.includes("project") && input.workspaceDir === undefined) {
      return yield* Effect.fail({
        type: "agent-preset-catalog-scope-invalid" as const,
        message: "Project Agent Presets require a workspace directory.",
      });
    }
    const scopes = (["host", "project", "global"] as const).filter(scope => requestedScopes.includes(scope));
    const entries: CatalogEntry[] = [];
    for (const scope of scopes) {
      if (scope === "host") {
        if (input.hostProvider === undefined) continue;
        const provided = yield* input.hostProvider({
          ...(input.workspaceDir === undefined ? {} : { workspaceDir: resolve(input.workspaceDir) }),
        });
        entries.push(...(yield* Effect.fromResult(validateHostPresets(provided))));
        continue;
      }
      const rootPath = scope === "project" ? resolve(input.workspaceDir!) : resolve(input.homeDir ?? homedir());
      const path = scope === "project"
        ? projectAcpusConfigPath(input.workspaceDir!)
        : globalAcpusConfigPath(input.homeDir);
      const loaded = yield* Effect.promise(() => loadPresetFile(scope, rootPath, path)).pipe(
        Effect.flatMap(Effect.fromResult),
      );
      entries.push(...loaded);
    }

    const effective = new Map<string, CatalogEntry>();
    for (const entry of entries) {
      if (!effective.has(entry.id)) effective.set(entry.id, entry);
    }
    const ordered = [...effective.values()].sort((left, right) => codeUnitCompare(left.id, right.id));
    return catalogFromEntries(ordered);
  });
}

export function normalizeAuthoringAgentScale(
  value: unknown,
): Result.Result<NormalizedAuthoringAgentScale, { type: "authoring-agent-scale-value-invalid"; message: string }> {
  const parsed = AuthoringAgentScaleSchema.safeParse(value);
  if (!parsed.success) {
    return Result.fail({
      type: "authoring-agent-scale-value-invalid",
      message: "Authoring Agent scale must be a positive safe integer or small, medium, large, or unrestricted.",
    });
  }
  return Result.succeed(normalizeKnownAuthoringAgentScale(parsed.data as AuthoringAgentScale));
}

function normalizeKnownAuthoringAgentScale(scale: AuthoringAgentScale): NormalizedAuthoringAgentScale {
  if (typeof scale === "number") return { value: scale, maxAgentOccurrences: scale };
  if (scale === "unrestricted") return { value: scale };
  return {
    value: scale,
    maxAgentOccurrences: scale === "small" ? 4 : scale === "medium" ? 12 : 32,
  };
}

export function loadAuthoringAgentScale(input: {
  workspaceDir?: string;
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
}): Effect.Effect<EffectiveAuthoringAgentScale | undefined, AcpusConfigReadFailure | AuthoringAgentScaleEnvironmentFailure> {
  return Effect.gen(function*() {
    const configs = yield* loadAuthoringConfigs(input);
    return yield* Effect.fromResult(resolveAuthoringAgentScale(configs, input.environment ?? process.env));
  });
}

export function loadAgentAuthoringContext(input: {
  workspaceDir?: string;
  homeDir?: string;
  hostProvider?: AgentPresetProvider;
  environment?: NodeJS.ProcessEnv;
}): Effect.Effect<AgentAuthoringContext, AgentAuthoringContextFailure> {
  return Effect.gen(function*() {
    const configs = yield* loadAuthoringConfigs(input);
    const entries: CatalogEntry[] = [];
    if (input.hostProvider !== undefined) {
      const provided = yield* input.hostProvider({
        ...(input.workspaceDir === undefined ? {} : { workspaceDir: resolve(input.workspaceDir) }),
      });
      entries.push(...(yield* Effect.fromResult(validateHostPresets(provided))));
    }
    if (configs.project !== undefined) entries.push(...entriesFromConfig("project", configs.project));
    entries.push(...entriesFromConfig("global", configs.global));
    const effective = new Map<string, CatalogEntry>();
    for (const entry of entries) {
      if (!effective.has(entry.id)) effective.set(entry.id, entry);
    }
    const ordered = [...effective.values()].sort((left, right) => codeUnitCompare(left.id, right.id));
    const scale = yield* Effect.fromResult(resolveAuthoringAgentScale(configs, input.environment ?? process.env));
    return {
      ...(scale === undefined ? {} : { scale }),
      presets: catalogFromEntries(ordered),
    };
  });
}

type LoadedAuthoringConfigs = {
  project?: AcpusConfig;
  global: AcpusConfig;
};

function loadAuthoringConfigs(input: {
  workspaceDir?: string;
  homeDir?: string;
}): Effect.Effect<LoadedAuthoringConfigs, AcpusConfigReadFailure> {
  return Effect.gen(function*() {
    const project = input.workspaceDir === undefined
      ? undefined
      : yield* loadAcpusConfigScope({ workspaceDir: input.workspaceDir, scope: "project" });
    const global = yield* loadAcpusConfigScope({
      ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
      scope: "global",
    });
    return { ...(project === undefined ? {} : { project }), global };
  });
}

function resolveAuthoringAgentScale(
  configs: LoadedAuthoringConfigs,
  environment: NodeJS.ProcessEnv,
): Result.Result<EffectiveAuthoringAgentScale | undefined, AuthoringAgentScaleEnvironmentFailure> {
  const environmentValue = environment[AUTHORING_AGENT_SCALE_ENV];
  if (environmentValue !== undefined) {
    const parsedValue: unknown = /^[1-9]\d*$/.test(environmentValue) ? Number(environmentValue) : environmentValue;
    const normalized = normalizeAuthoringAgentScale(parsedValue);
    if (Result.isFailure(normalized)) {
      return Result.fail({
        type: "authoring-agent-scale-environment-invalid",
        variable: AUTHORING_AGENT_SCALE_ENV,
        value: environmentValue,
        message: `${AUTHORING_AGENT_SCALE_ENV} must be a positive safe integer or small, medium, large, or unrestricted.`,
      });
    }
    return Result.succeed({ ...normalized.success, source: "environment" });
  }
  const project = configs.project?.authoring.agentScale;
  if (project !== undefined) {
    return Result.succeed({ ...normalizeKnownAuthoringAgentScale(project), source: "project" });
  }
  const global = configs.global.authoring.agentScale;
  if (global !== undefined) {
    return Result.succeed({ ...normalizeKnownAuthoringAgentScale(global), source: "global" });
  }
  return Result.succeed(undefined);
}

function entriesFromConfig(scope: WritableAgentPresetScope, config: AcpusConfig): CatalogEntry[] {
  return Object.entries(config.presets).map(([id, preset]) => entryFromPreset(id, scope, preset));
}

export function applyAgentPresetChanges(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  changes: readonly AgentPresetChange[];
}): Effect.Effect<{ path: string; presets: Record<string, AgentPresetSpec> }, AgentPresetWriteFailure> {
  return Effect.promise(() => applyChanges(input)).pipe(Effect.flatMap(Effect.fromResult), Effect.uninterruptible);
}

export function addAgentPreset(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  id: string;
  preset: AgentPresetSpec;
}): Effect.Effect<{ path: string; preset: AgentPresetSpec }, AgentPresetWriteFailure> {
  return Effect.promise(() => addPreset(input)).pipe(Effect.flatMap(Effect.fromResult), Effect.uninterruptible);
}

export function removeAgentPreset(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  id: string;
}): Effect.Effect<{ path: string }, AgentPresetWriteFailure> {
  return Effect.promise(() => removePreset(input)).pipe(Effect.flatMap(Effect.fromResult), Effect.uninterruptible);
}

export function setAuthoringAgentScale(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  value: AuthoringAgentScale;
}): Effect.Effect<{ path: string; scale: NormalizedAuthoringAgentScale }, AuthoringAgentScaleWriteFailure> {
  return Effect.promise(() => writeAuthoringAgentScale(input, false)).pipe(Effect.flatMap(Effect.fromResult), Effect.uninterruptible);
}

export function unsetAuthoringAgentScale(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
}): Effect.Effect<{ path: string }, AuthoringAgentScaleWriteFailure> {
  return Effect.promise(() => writeAuthoringAgentScale(input, true)).pipe(
    Effect.flatMap(Effect.fromResult),
    Effect.map(result => ({ path: result.path })),
    Effect.uninterruptible,
  );
}

async function writeAuthoringAgentScale(
  input: {
    workspaceDir?: string;
    homeDir?: string;
    scope: WritableAgentPresetScope;
    value?: AuthoringAgentScale;
  },
  unset: boolean,
): Promise<Result.Result<{ path: string; scale: NormalizedAuthoringAgentScale }, AuthoringAgentScaleWriteFailure>> {
  if (input.scope !== "project" && input.scope !== "global") {
    return Result.fail({ type: "authoring-agent-scale-scope-invalid", message: "Authoring Agent scale scope must be project or global." });
  }
  if (input.scope === "project" && input.workspaceDir === undefined) {
    return Result.fail({ type: "authoring-agent-scale-scope-invalid", message: "Project Authoring Agent scale requires a workspace directory." });
  }
  const normalized = unset
    ? Result.succeed<NormalizedAuthoringAgentScale>({ value: "unrestricted" })
    : normalizeAuthoringAgentScale(input.value);
  if (Result.isFailure(normalized)) return Result.fail(normalized.failure);
  const rootPath = input.scope === "project" ? resolve(input.workspaceDir!) : resolve(input.homeDir ?? homedir());
  let path = input.scope === "project" ? projectAcpusConfigPath(input.workspaceDir!) : globalAcpusConfigPath(input.homeDir);
  let boundary: ConfigFileBoundary | undefined;
  try {
    boundary = unset
      ? await preparePresetFileBoundary(rootPath, false)
      : await preparePresetFileBoundary(rootPath, true);
    if (boundary === undefined) return Result.succeed({ path, scale: normalized.success });
    path = boundary.path;
    if (input.scope === "global" && process.platform !== "win32") {
      await verifyPresetFileBoundary(boundary);
      await chmod(boundary.parentPath, 0o700);
      await verifyPresetFileBoundary(boundary);
    }
  } catch (error) {
    return Result.fail({
      type: "authoring-agent-scale-write-failed",
      scope: input.scope,
      path,
      message: `Failed to prepare Acpus config at '${path}': ${causeMessage(error)}`,
    });
  }
  const lockPath = `${path}.lock`;
  let lock: ConfigFileLock | undefined;
  try {
    lock = await acquirePresetFileLock(lockPath);
  } catch (error) {
    return Result.fail({
      type: "authoring-agent-scale-write-failed",
      scope: input.scope,
      path,
      message: `Failed to lock Acpus config at '${path}': ${causeMessage(error)}`,
    });
  }
  if (lock === undefined) {
    return Result.fail({
      type: "authoring-agent-scale-busy",
      scope: input.scope,
      path,
      message: `Acpus config at '${path}' is being updated by another process.`,
    });
  }
  try {
    await verifyPresetFileBoundary(boundary);
    let current = await readAcpusConfigFile(input.scope, rootPath, path, boundary);
    if (unset) {
      if (Result.isSuccess(current) && current.success.authoring.agentScale === undefined) {
        return Result.succeed({ path, scale: normalized.success });
      }
      if (Result.isFailure(current)) {
        current = await readAcpusConfigFile(input.scope, rootPath, path, boundary, { ignoreAuthoring: true });
      }
    } else {
      current = await readAcpusConfigFile(input.scope, rootPath, path, boundary, { ignoreAuthoring: true });
    }
    if (Result.isFailure(current)) return Result.fail(current.failure);
    const authoring = unset ? {} : { agentScale: normalized.success.value };
    try {
      await verifyPresetFileBoundary(boundary);
      await writePrivateJsonAtomically(path, serializeAcpusConfig({ ...current.success, authoring }));
      await verifyPresetFileBoundary(boundary);
    } catch (error) {
      return Result.fail({
        type: "authoring-agent-scale-write-failed",
        scope: input.scope,
        path,
        message: `Failed to write Acpus config at '${path}': ${causeMessage(error)}`,
      });
    }
    return Result.succeed({ path, scale: normalized.success });
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function addPreset(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  id: string;
  preset: AgentPresetSpec;
}): Promise<Result.Result<{ path: string; preset: AgentPresetSpec }, AgentPresetWriteFailure>> {
  const applied = await mutatePresetFile(
    { ...input, changes: [{ type: "set", id: input.id, preset: input.preset }] },
    { state: "absent", id: input.id },
  );
  return Result.map(applied, result => ({ path: result.path, preset: result.presets[input.id]! }));
}

async function removePreset(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  id: string;
}): Promise<Result.Result<{ path: string }, AgentPresetWriteFailure>> {
  const applied = await mutatePresetFile(
    { ...input, changes: [{ type: "remove", id: input.id }] },
    { state: "present", id: input.id },
  );
  return Result.map(applied, result => ({ path: result.path }));
}

async function applyChanges(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  changes: readonly AgentPresetChange[];
}): Promise<Result.Result<{ path: string; presets: Record<string, AgentPresetSpec> }, AgentPresetWriteFailure>> {
  return mutatePresetFile(input);
}

async function mutatePresetFile(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
  changes: readonly AgentPresetChange[];
}, requirement?: { state: "absent" | "present"; id: string }): Promise<Result.Result<{ path: string; presets: Record<string, AgentPresetSpec> }, AgentPresetWriteFailure>> {
  if (input.scope !== "project" && input.scope !== "global") {
    return Result.fail({ type: "agent-preset-catalog-scope-invalid", message: "Writable Agent Preset scope must be project or global." });
  }
  if (input.changes.length === 0) {
    return Result.fail({ type: "agent-preset-changes-invalid", message: "Agent Preset changes must not be empty." });
  }
  const duplicate = firstDuplicate(input.changes.map(change => change.id));
  if (duplicate !== undefined) {
    return Result.fail({ type: "agent-preset-changes-invalid", message: `Agent Preset changes contain duplicate id '${duplicate}'.` });
  }
  const pathResult = writablePresetPath(input);
  if (Result.isFailure(pathResult)) return Result.fail(pathResult.failure);
  let path = pathResult.success;
  for (const change of input.changes) {
    const idFailure = validateWritablePresetId(change.id);
    if (idFailure !== undefined) return Result.fail(idFailure);
    if (change.type === "set") {
      const preset = AgentPresetSpecSchema.safeParse(change.preset);
      if (!preset.success) {
        return Result.fail({
          type: "agent-preset-changes-invalid",
          message: `Agent Preset '${change.id}' is invalid: ${preset.error.issues.map(formatIssue).join("; ")}`,
        });
      }
    }
  }

  let boundary: ConfigFileBoundary;
  try {
    boundary = await preparePresetFileBoundary(presetRootPath(input), true);
    path = boundary.path;
    if (input.scope === "global" && process.platform !== "win32") {
      await verifyPresetFileBoundary(boundary);
      await chmod(boundary.parentPath, 0o700);
      await verifyPresetFileBoundary(boundary);
    }
  } catch (error) {
    return Result.fail({
      type: "agent-preset-write-failed",
      scope: input.scope,
      path,
      message: `Failed to prepare Acpus config at '${path}': ${causeMessage(error)}`,
    });
  }
  const lockPath = `${path}.lock`;
  let lock: ConfigFileLock | undefined;
  try {
    lock = await acquirePresetFileLock(lockPath);
  } catch (error) {
    return Result.fail({
      type: "agent-preset-write-failed",
      scope: input.scope,
      path,
      message: `Failed to lock Acpus config at '${path}': ${causeMessage(error)}`,
    });
  }
  if (lock === undefined) {
    return Result.fail({
      type: "agent-preset-busy",
      scope: input.scope,
      path,
      message: `Acpus config at '${path}' is being updated by another process.`,
    });
  }

  try {
    await verifyPresetFileBoundary(boundary);
    const current = await readAcpusConfigFile(input.scope, presetRootPath(input), path, boundary);
    if (Result.isFailure(current)) return Result.fail(current.failure);
    if (requirement?.state === "absent" && Object.hasOwn(current.success.presets, requirement.id)) {
      return Result.fail({ type: "agent-preset-exists", id: requirement.id, message: `Agent Preset '${requirement.id}' already exists in ${input.scope} scope.` });
    }
    if (requirement?.state === "present" && !Object.hasOwn(current.success.presets, requirement.id)) {
      return Result.fail({ type: "agent-preset-missing", id: requirement.id, message: `Agent Preset '${requirement.id}' does not exist in ${input.scope} scope.` });
    }
    const next = { ...current.success.presets };
    for (const change of input.changes) {
      if (change.type === "remove") {
        delete next[change.id];
      } else {
        next[change.id] = AgentPresetSpecSchema.parse(change.preset) as AgentPresetSpec;
      }
    }
    if (Object.keys(next).length > MAX_PRESETS_PER_SCOPE) {
      return Result.fail({
        type: "agent-preset-changes-invalid",
        message: `Agent Preset scope '${input.scope}' may contain at most ${MAX_PRESETS_PER_SCOPE} presets.`,
      });
    }
    const ordered = Object.fromEntries(Object.entries(next).sort(([left], [right]) => codeUnitCompare(left, right))) as Record<string, AgentPresetSpec>;
    try {
      await verifyPresetFileBoundary(boundary);
      await writePrivateJsonAtomically(path, serializeAcpusConfig({ ...current.success, presets: ordered }));
      await verifyPresetFileBoundary(boundary);
    } catch (error) {
      return Result.fail({
        type: "agent-preset-write-failed",
        scope: input.scope,
        path,
        message: `Failed to write Acpus config at '${path}': ${causeMessage(error)}`,
      });
    }
    return Result.succeed({ path, presets: ordered });
  } finally {
    await lock.release().catch(() => undefined);
  }
}

function writablePresetPath(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
}): Result.Result<string, AgentPresetWriteFailure> {
  if (input.scope === "project") {
    if (input.workspaceDir === undefined) {
      return Result.fail({ type: "agent-preset-catalog-scope-invalid", message: "Project Agent Presets require a workspace directory." });
    }
    return Result.succeed(projectAcpusConfigPath(input.workspaceDir));
  }
  return Result.succeed(globalAcpusConfigPath(input.homeDir));
}

function presetRootPath(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
}): string {
  return input.scope === "project" ? resolve(input.workspaceDir!) : resolve(input.homeDir ?? homedir());
}

export function loadAcpusConfigScope(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
}): Effect.Effect<AcpusConfig, AcpusConfigReadFailure> {
  return Effect.promise(() => loadAcpusConfigScopeResult(input)).pipe(Effect.flatMap(Effect.fromResult));
}

export function loadAcpusConfigScopeResult(input: {
  workspaceDir?: string;
  homeDir?: string;
  scope: WritableAgentPresetScope;
}): Promise<Result.Result<AcpusConfig, AcpusConfigReadFailure>> {
  if (input.scope === "project" && input.workspaceDir === undefined) {
    return Promise.resolve(Result.fail({
      type: "acpus-config-read-failed" as const,
      source: "project" as const,
      path: "",
      message: "Project Acpus config requires a workspace directory.",
    }));
  }
  const rootPath = input.scope === "project"
    ? resolve(input.workspaceDir!)
    : resolve(input.homeDir ?? homedir());
  const path = input.scope === "project"
    ? projectAcpusConfigPath(input.workspaceDir!)
    : globalAcpusConfigPath(input.homeDir);
  return readAcpusConfigFile(input.scope, rootPath, path);
}

export function resolveConfiguredAgentCommand(input: {
  workspaceDir: string;
  homeDir?: string;
  names: readonly string[];
}): Effect.Effect<string | undefined, AcpusConfigReadFailure> {
  return Effect.promise(() => resolveConfiguredAgentCommandResult(input)).pipe(Effect.flatMap(Effect.fromResult));
}

async function resolveConfiguredAgentCommandResult(input: {
  workspaceDir: string;
  homeDir?: string;
  names: readonly string[];
}): Promise<Result.Result<string | undefined, AcpusConfigReadFailure>> {
    const project = await loadAcpusConfigScopeResult({
      workspaceDir: input.workspaceDir,
      scope: "project",
    });
    if (Result.isFailure(project)) return Result.fail(project.failure);
    const global = await loadAcpusConfigScopeResult({
      ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
      scope: "global",
    });
    if (Result.isFailure(global)) return Result.fail(global.failure);
    for (const name of input.names) {
      const command = project.success.agents[name];
      if (command !== undefined) return Result.succeed(command);
    }
    for (const name of input.names) {
      const command = global.success.agents[name];
      if (command !== undefined) return Result.succeed(command);
    }
    return Result.succeed(undefined);
}

async function readAcpusConfigFile(
  scope: WritableAgentPresetScope,
  rootPath: string,
  path: string,
  openedBoundary?: ConfigFileBoundary,
  options?: { ignoreAuthoring?: boolean },
): Promise<Result.Result<AcpusConfig, AcpusConfigReadFailure>> {
  let boundary: ConfigFileBoundary | undefined;
  let openedFileIdentity: string | undefined;
  try {
    boundary = openedBoundary ?? await preparePresetFileBoundary(rootPath, false);
    if (boundary === undefined) return Result.succeed(emptyAcpusConfig());
    path = boundary.path;
    openedFileIdentity = await verifyPresetFileBoundary(boundary);
  } catch (error) {
    return Result.fail({ type: "acpus-config-read-failed", source: scope, path, message: causeMessage(error) });
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return Result.succeed(emptyAcpusConfig());
    return Result.fail({ type: "acpus-config-read-failed", source: scope, path, message: causeMessage(error) });
  }
  try {
    if (await verifyPresetFileBoundary(boundary) !== openedFileIdentity) {
      throw new Error(`Acpus config file '${path}' changed while it was being read.`);
    }
  } catch (error) {
    return Result.fail({ type: "acpus-config-read-failed", source: scope, path, message: causeMessage(error) });
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: `Invalid JSON: ${causeMessage(error)}` });
  }
  return parseAcpusConfig(value, scope, path, options);
}

function parseAcpusConfig(
  value: unknown,
  scope: WritableAgentPresetScope,
  path: string,
  options?: { ignoreAuthoring?: boolean },
): Result.Result<AcpusConfig, AcpusConfigReadFailure> {
  const parsed = AcpusConfigFileSchema.safeParse(value);
  if (!parsed.success) {
    return Result.fail({
      type: "acpus-config-invalid",
      source: scope,
      path,
      message: parsed.error.issues.map(formatIssue).join("; "),
    });
  }
  const agents = parseConfiguredAgents(parsed.data.agents, scope, path);
  if (Result.isFailure(agents)) return Result.fail(agents.failure);
  const authoring = AcpusAuthoringConfigSchema.safeParse(options?.ignoreAuthoring === true ? {} : parsed.data.authoring ?? {});
  if (!authoring.success) {
    return Result.fail({
      type: "acpus-config-invalid",
      source: scope,
      path,
      message: authoring.error.issues.map(issue => formatIssueAt(["authoring"], issue)).join("; "),
    });
  }
  const presetValue = parsed.data.presets ?? {};
  if (!isPlainRecord(presetValue)) {
    return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: "$.presets must be an object." });
  }
  const presetEntries: Array<[string, AgentPresetSpec]> = [];
  for (const id of Object.keys(presetValue).sort(codeUnitCompare)) {
    if (!validPresetId(id)) {
      return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: `Agent Preset id '${id}' must match ${AGENT_PRESET_ID}.` });
    }
    if (RESERVED_PRESET_IDS.has(id)) {
      return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: `Agent Preset id '${id}' is reserved for the Host scope.` });
    }
    const preset = AgentPresetSpecSchema.safeParse(presetValue[id]);
    if (!preset.success) {
      return Result.fail({
        type: "acpus-config-invalid",
        source: scope,
        path,
        message: preset.error.issues.map(issue => formatIssueAt(["presets", id], issue)).join("; "),
      });
    }
    presetEntries.push([id, preset.data as AgentPresetSpec]);
  }
  if (presetEntries.length > MAX_PRESETS_PER_SCOPE) {
    return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: `Agent Preset scope '${scope}' may contain at most ${MAX_PRESETS_PER_SCOPE} presets.` });
  }
  const hooks = validateHooksFile(parsed.data.hooks ?? {});
  if (Result.isFailure(hooks)) {
    return Result.fail({
      type: "acpus-config-invalid",
      source: scope,
      path,
      message: hooks.failure.map(error => `${prefixConfigPath("hooks", error.path)}: ${error.message}`).join("; "),
    });
  }
  return Result.succeed({
    agents: agents.success,
    presets: Object.fromEntries(presetEntries) as Record<string, AgentPresetSpec>,
    authoring: authoring.data as AcpusAuthoringConfig,
    hooks: hooks.success,
  });
}

function parseConfiguredAgents(
  value: unknown,
  scope: WritableAgentPresetScope,
  path: string,
): Result.Result<Record<string, string>, AcpusConfigReadFailure> {
  if (value === undefined) return Result.succeed({});
  if (!isPlainRecord(value)) {
    return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: "$.agents must be an object." });
  }
  const entries: Array<[string, string]> = [];
  const sourceNames = new Map<string, string>();
  for (const [sourceName, command] of Object.entries(value)) {
    const name = sourceName.trim().toLowerCase();
    if (name.length === 0) {
      return Result.fail({ type: "acpus-config-invalid", source: scope, path, message: "$.agents Agent names must contain a non-whitespace character." });
    }
    const colliding = sourceNames.get(name);
    if (colliding !== undefined) {
      return Result.fail({
        type: "acpus-config-invalid",
        source: scope,
        path,
        message: `$.agents names ${JSON.stringify(colliding)} and ${JSON.stringify(sourceName)} both normalize to '${name}'.`,
      });
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return Result.fail({
        type: "acpus-config-invalid",
        source: scope,
        path,
        message: `$.agents.${sourceName} must be a non-empty shell command string.`,
      });
    }
    sourceNames.set(name, sourceName);
    entries.push([name, command]);
  }
  entries.sort(([left], [right]) => codeUnitCompare(left, right));
  return Result.succeed(Object.fromEntries(entries));
}

function emptyAcpusConfig(): AcpusConfig {
  return { agents: {}, presets: {}, authoring: {}, hooks: {} };
}

function serializeAcpusConfig(config: AcpusConfig): Partial<AcpusConfig> {
  return {
    ...(Object.keys(config.agents).length === 0 ? {} : { agents: config.agents }),
    ...(Object.keys(config.presets).length === 0 ? {} : { presets: config.presets }),
    ...(config.authoring.agentScale === undefined ? {} : { authoring: config.authoring }),
    ...(Object.keys(config.hooks).length === 0 ? {} : { hooks: config.hooks }),
  };
}

function prefixConfigPath(section: string, path: string): string {
  return path === "$" ? `$.${section}` : `$.${section}${path.slice(1)}`;
}

async function loadPresetFile(
  scope: WritableAgentPresetScope,
  rootPath: string,
  path: string,
): Promise<Result.Result<CatalogEntry[], AgentPresetCatalogFailure>> {
  const config = await readAcpusConfigFile(scope, rootPath, path);
  if (Result.isFailure(config)) return Result.fail(config.failure);
  return Result.succeed(Object.entries(config.success.presets).map(([id, preset]) => entryFromPreset(id, scope, preset)));
}

function validateHostPresets(value: readonly HostAgentPreset[]): Result.Result<CatalogEntry[], AgentPresetCatalogFailure> {
  if (value.length > MAX_PRESETS_PER_SCOPE) {
    return Result.fail({ type: "agent-preset-catalog-invalid", source: "host", message: `Host Agent Presets may contain at most ${MAX_PRESETS_PER_SCOPE} presets.` });
  }
  const entries: CatalogEntry[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || !validPresetId(candidate.id)) {
      return Result.fail({ type: "agent-preset-catalog-invalid", source: "host", message: `Host Agent Preset ids must match ${AGENT_PRESET_ID}.` });
    }
    if (ids.has(candidate.id)) {
      return Result.fail({ type: "agent-preset-catalog-invalid", source: "host", message: `Host Agent Preset id '${candidate.id}' is duplicated.` });
    }
    const parsed = AgentPresetSpecSchema.safeParse({ guidance: candidate.guidance, agent: candidate.agent });
    if (!parsed.success) {
      return Result.fail({ type: "agent-preset-catalog-invalid", source: "host", message: `Host Agent Preset '${candidate.id}' is invalid: ${parsed.error.issues.map(formatIssue).join("; ")}` });
    }
    ids.add(candidate.id);
    entries.push(entryFromPreset(candidate.id, "host", parsed.data as AgentPresetSpec));
  }
  return Result.succeed(entries);
}

function entryFromPreset(id: string, scope: AgentPresetScope, preset: AgentPresetSpec): CatalogEntry {
  return {
    id,
    scope,
    guidance: preset.guidance,
    definition: definitionFromSpec(preset.agent),
  };
}

function definitionFromSpec(agent: AgentPresetSpec["agent"]): AgentDefinitionIR {
  const options = {
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.config === undefined ? {} : { config: { ...agent.config } }),
    ...(agent.permissionMode === undefined ? {} : { permissionMode: agent.permissionMode }),
    ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
    ...(agent.env === undefined ? {} : { env: { ...agent.env } }),
  };
  return agent.command === undefined
    ? { kind: "agent_definition", use: agent.use, ...options }
    : { kind: "agent_command", command: agent.command, ...options };
}

function catalogFromEntries(entries: readonly CatalogEntry[]): AgentPresetCatalog {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  return {
    choices: entries.map(entry => ({
      id: entry.id,
      guidance: entry.guidance,
      scope: entry.scope,
    })),
    resolve(ids) {
      const resolved: Record<string, ResolvedAgentPreset> = {};
      for (const id of [...new Set(ids)].sort(codeUnitCompare)) {
        const entry = byId.get(id);
        if (entry === undefined) {
          return Result.fail({ type: "agent-preset-not-found", id, message: `Agent Preset '${id}' was not found.` });
        }
        const definition = structuredClone(entry.definition);
        resolved[id] = {
          id,
          scope: entry.scope,
          definition,
        };
      }
      return Result.succeed(resolved);
    },
  };
}

async function acquirePresetFileLock(path: string): Promise<ConfigFileLock | undefined> {
  const owner: ConfigLockOwner = { ...captureProcessIdentity(), token: randomUUID() };
  if (await publishPresetFileLock(path, owner)) return ownedPresetFileLock(path, owner);
  const staleIdentity = await provablyDeadPresetLockIdentity(path);
  if (staleIdentity === undefined) return undefined;
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return await publishPresetFileLock(path, owner) ? ownedPresetFileLock(path, owner) : undefined;
  }
  if (current.isSymbolicLink()
    || !current.isFile()
    || filesystemIdentity(current, `Acpus config lock '${path}'`) !== staleIdentity) return undefined;
  await rm(path);
  return await publishPresetFileLock(path, owner) ? ownedPresetFileLock(path, owner) : undefined;
}

async function publishPresetFileLock(path: string, owner: ConfigLockOwner): Promise<boolean> {
  const temporary = `${path}.${owner.token}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function ownedPresetFileLock(path: string, owner: ConfigLockOwner): ConfigFileLock {
  return {
    async release() {
      const current = await readPresetLockOwner(path);
      if (current?.owner.token === owner.token) await rm(path, { force: true });
    },
  };
}

async function provablyDeadPresetLockIdentity(path: string): Promise<string | undefined> {
  const current = await readPresetLockOwner(path);
  if (current === undefined) return undefined;
  return probeProcessIdentity({
    pid: current.owner.pid,
    ...(current.owner.startToken === undefined ? {} : { startToken: current.owner.startToken }),
  }) === "dead" ? current.identity : undefined;
}

async function readPresetLockOwner(
  path: string,
): Promise<{ owner: ConfigLockOwner; identity: string } | undefined> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) return undefined;
  const identity = filesystemIdentity(before, `Acpus config lock '${path}'`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
  if (!isPresetLockOwner(value)) return undefined;
  let after;
  try {
    after = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (after.isSymbolicLink()
    || !after.isFile()
    || filesystemIdentity(after, `Acpus config lock '${path}'`) !== identity) return undefined;
  return { owner: value, identity };
}

function isPresetLockOwner(value: unknown): value is ConfigLockOwner {
  return isPlainRecord(value)
    && typeof value.pid === "number"
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && (value.startToken === undefined || typeof value.startToken === "string")
    && typeof value.token === "string"
    && value.token.length > 0;
}

async function preparePresetFileBoundary(rootPath: string, createParent: true): Promise<ConfigFileBoundary>;
async function preparePresetFileBoundary(rootPath: string, createParent: false): Promise<ConfigFileBoundary | undefined>;
async function preparePresetFileBoundary(
  rootPath: string,
  createParent: boolean,
): Promise<ConfigFileBoundary | undefined> {
  const rootRealpath = await realpath(resolve(rootPath));
  const rootInfo = await lstat(rootRealpath, { bigint: true });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Acpus config root '${rootRealpath}' is not a regular directory.`);
  }
  const parentPath = join(rootRealpath, ".acpus");
  let parentInfo;
  try {
    parentInfo = await lstat(parentPath, { bigint: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (!createParent) return undefined;
    await mkdir(parentPath, { mode: 0o700 }).catch(error => {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    });
    parentInfo = await lstat(parentPath, { bigint: true });
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error(`Acpus config directory '${parentPath}' is not a regular directory.`);
  }
  const parentRealpath = await realpath(parentPath);
  if (parentRealpath !== join(rootRealpath, ".acpus")) {
    throw new Error(`Acpus config directory '${parentPath}' is outside root '${rootRealpath}'.`);
  }
  return {
    rootPath: rootRealpath,
    rootRealpath,
    rootIdentity: filesystemIdentity(rootInfo, `Acpus config root '${rootRealpath}'`),
    parentPath,
    parentRealpath,
    parentIdentity: filesystemIdentity(parentInfo, `Acpus config directory '${parentPath}'`),
    path: join(parentPath, "config.json"),
  };
}

async function verifyPresetFileBoundary(boundary: ConfigFileBoundary): Promise<string | undefined> {
  const rootInfo = await lstat(boundary.rootPath, { bigint: true });
  if (rootInfo.isSymbolicLink()
    || !rootInfo.isDirectory()
    || await realpath(boundary.rootPath) !== boundary.rootRealpath
    || filesystemIdentity(rootInfo, `Acpus config root '${boundary.rootPath}'`) !== boundary.rootIdentity) {
    throw new Error(`Acpus config root '${boundary.rootPath}' no longer matches its opened identity.`);
  }
  const parentInfo = await lstat(boundary.parentPath, { bigint: true });
  if (parentInfo.isSymbolicLink()
    || !parentInfo.isDirectory()
    || await realpath(boundary.parentPath) !== boundary.parentRealpath
    || filesystemIdentity(parentInfo, `Acpus config directory '${boundary.parentPath}'`) !== boundary.parentIdentity) {
    throw new Error(`Acpus config directory '${boundary.parentPath}' no longer matches its opened identity.`);
  }
  let fileInfo;
  try {
    fileInfo = await lstat(boundary.path, { bigint: true });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`Acpus config file '${boundary.path}' is not a regular file.`);
  }
  if (dirname(await realpath(boundary.path)) !== boundary.parentRealpath) {
    throw new Error(`Acpus config file '${boundary.path}' is outside its scope directory.`);
  }
  return filesystemIdentity(fileInfo, `Acpus config file '${boundary.path}'`);
}

function filesystemIdentity(
  info: { dev: bigint; ino: bigint; birthtimeMs: bigint },
  label: string,
): string {
  if (info.ino === 0n) throw new Error(`${label} does not expose a stable filesystem identity.`);
  return `${info.dev}:${info.ino}${info.birthtimeMs === 0n ? "" : `:${info.birthtimeMs}`}`;
}

function validPresetId(value: string): boolean {
  return AGENT_PRESET_ID.test(value);
}

function validateWritablePresetId(id: string): Extract<AgentPresetWriteFailure, { type: "agent-preset-changes-invalid" }> | undefined {
  if (!validPresetId(id)) {
    return { type: "agent-preset-changes-invalid", message: `Agent Preset id '${id}' must match ${AGENT_PRESET_ID}.` };
  }
  if (RESERVED_PRESET_IDS.has(id)) {
    return { type: "agent-preset-changes-invalid", message: `Agent Preset id '${id}' is reserved for the Host scope.` };
  }
  return undefined;
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
  return `${path} ${issue.message}`;
}

function formatIssueAt(prefix: PropertyKey[], issue: { path: PropertyKey[]; message: string }): string {
  return `$.${[...prefix, ...issue.path].join(".")} ${issue.message}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
