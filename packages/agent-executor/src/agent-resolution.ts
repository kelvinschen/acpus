import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import type {
  AcpAgentLaunch,
  AgentSelector,
  NamedAcpAgentLaunchRegistry,
} from "./types.js";

const ADAPTER_RANGES = {
  pi: "^0.0.31",
  codex: "^1.1.5",
  claude: "^0.60.0",
  mux: "^0.28.0",
} as const;

const BUILT_IN_AGENT_LAUNCHES: Readonly<Record<string, readonly [string, ...string[]]>> = {
  pi: ["npx", `pi-acp@${ADAPTER_RANGES.pi}`],
  openclaw: ["openclaw", "acp"],
  codex: ["npx", "-y", `@agentclientprotocol/codex-acp@${ADAPTER_RANGES.codex}`],
  claude: ["npx", "-y", `@agentclientprotocol/claude-agent-acp@${ADAPTER_RANGES.claude}`],
  gemini: ["gemini", "--acp"],
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp", "--stdio"],
  droid: ["droid", "exec", "--output-format", "acp"],
  "fast-agent": ["uvx", "fast-agent-mcp", "acp"],
  "grok-build": ["grok", "agent", "stdio"],
  iflow: ["iflow", "--experimental-acp"],
  kilocode: ["npx", "-y", "@kilocode/cli", "acp"],
  kimi: ["kimi", "acp"],
  kiro: ["kiro-cli-chat", "acp"],
  mux: ["npx", "-y", `mux@${ADAPTER_RANGES.mux}`, "acp"],
  opencode: ["npx", "-y", "opencode-ai", "acp"],
  pool: ["pool", "acp"],
  qoder: ["qodercli", "--acp"],
  qwen: ["qwen", "--acp"],
  trae: ["traecli", "acp", "serve"],
  zeroclaw: ["zeroclaw", "acp"],
};

const BUILT_IN_AGENT_ALIASES: Readonly<Record<string, string>> = {
  "factory-droid": "droid",
  factorydroid: "droid",
};

export type AcpAgentResolutionFailure = {
  type: "agent-config";
  message: string;
};

export type AcpAgentConfig = ReadonlyMap<string, readonly [string, ...string[]]>;

export class AcpAgentResolutionSystemError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpAgentResolutionSystemError";
  }
}

export function resolveAcpAgentLaunch(input: {
  agent: AgentSelector;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
}): ResultAsync<AcpAgentLaunch, AcpAgentResolutionFailure> {
  if (input.agent.kind === "command") {
    return okAsync({ kind: "command", command: input.agent.command });
  }

  const name = normalizeAgentName(input.agent.name);
  if (!name) return errAsync(configFailure("Named Agent name must contain a non-whitespace character."));

  if (input.namedAgentLaunches !== undefined && Object.hasOwn(input.namedAgentLaunches, name)) {
    return okAsync({
      kind: "argv",
      argv: resolveHostAgentLaunch(input.namedAgentLaunches[name], name, input.model),
      name,
    });
  }

  return resolveNamedAcpAgentLaunch({ name, cwd: input.cwd, env: input.env });
}

export function resolveNamedAcpAgentLaunch(input: {
  name: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ResultAsync<AcpAgentLaunch, AcpAgentResolutionFailure> {
  return new ResultAsync(resolveNamedAcpAgentLaunchValue(input));
}

export function parseAcpAgentConfig(content: string, path: string): Result<AcpAgentConfig, AcpAgentResolutionFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return err(configFailure(`Invalid Agent config at '${path}': invalid JSON: ${causeMessage(error)}`));
  }

  if (!record(parsed) || !hasExactKeys(parsed, ["agents"]) || !record(parsed.agents)) {
    return err(configFailure(`Invalid Agent config at '${path}': expected exactly {"agents": {...}}.`));
  }

  const agents = new Map<string, readonly [string, ...string[]]>();
  const sourceNames = new Map<string, string>();
  for (const [sourceName, entry] of Object.entries(parsed.agents)) {
    const name = normalizeAgentName(sourceName);
    if (!name) {
      return err(configFailure(`Invalid Agent config at '${path}': Agent names must contain a non-whitespace character.`));
    }
    const collidingName = sourceNames.get(name);
    if (collidingName !== undefined) {
      return err(configFailure(
        `Invalid Agent config at '${path}': Agent names ${JSON.stringify(collidingName)} and ${JSON.stringify(sourceName)} both normalize to '${name}'.`,
      ));
    }
    if (!record(entry) || !hasExactKeys(entry, ["argv"]) || !agentArgv(entry.argv)) {
      return err(configFailure(
        `Invalid Agent config at '${path}' for Agent ${JSON.stringify(sourceName)}: expected exactly {"argv": ["executable", ...]}.`,
      ));
    }
    sourceNames.set(name, sourceName);
    agents.set(name, [...entry.argv]);
  }
  return ok(agents);
}

async function resolveNamedAcpAgentLaunchValue(input: {
  name: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Result<AcpAgentLaunch, AcpAgentResolutionFailure>> {
  const name = normalizeAgentName(input.name);
  if (!name) return err(configFailure("Named Agent name must contain a non-whitespace character."));

  const projectPath = projectAgentConfigPath(input.cwd);
  const globalPath = globalAgentConfigPath(input.env);
  const [project, global] = await Promise.all([
    readAgentConfig(projectPath),
    globalPath === undefined
      ? Promise.resolve(ok(new Map<string, readonly [string, ...string[]]>()))
      : readAgentConfig(globalPath),
  ]);
  if (project.isErr()) return err(project.error);
  if (global.isErr()) return err(global.error);

  const configured = resolveConfiguredAgent(project.value, name) ?? resolveConfiguredAgent(global.value, name);
  if (configured !== undefined) return ok({ kind: "argv", argv: copyArgv(configured), name });

  const builtIn = resolveBuiltInAgent(name);
  if (builtIn !== undefined) return ok({ kind: "argv", argv: copyArgv(builtIn), name });

  return err(configFailure(
    `Named Agent '${name}' is not configured or built in. Add it to '${projectPath}' with a structured argv or use an explicit command selector.`,
  ));
}

async function readAgentConfig(path: string): Promise<Result<AcpAgentConfig, AcpAgentResolutionFailure>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return ok(new Map());
    return err(configFailure(`Failed to read Agent config at '${path}': ${causeMessage(error)}`));
  }
  return parseAcpAgentConfig(content, path);
}

function resolveConfiguredAgent(
  config: AcpAgentConfig,
  name: string,
): readonly [string, ...string[]] | undefined {
  return config.get(name) ?? config.get(canonicalAgentName(name));
}

function resolveBuiltInAgent(name: string): readonly [string, ...string[]] | undefined {
  const canonicalName = canonicalAgentName(name);
  return Object.hasOwn(BUILT_IN_AGENT_LAUNCHES, canonicalName)
    ? BUILT_IN_AGENT_LAUNCHES[canonicalName]
    : undefined;
}

function resolveHostAgentLaunch(
  resolver: NamedAcpAgentLaunchRegistry[string] | undefined,
  name: string,
  model: string | undefined,
): [string, ...string[]] {
  if (typeof resolver !== "function") {
    throw new AcpAgentResolutionSystemError(`Host resolver for named Agent '${name}' is not callable.`);
  }
  let launch: unknown;
  try {
    launch = resolver(model === undefined ? {} : { model });
  } catch (error) {
    throw new AcpAgentResolutionSystemError(`Host resolver for named Agent '${name}' failed.`, { cause: error });
  }
  if (!agentArgv(launch)) {
    throw new AcpAgentResolutionSystemError(`Host resolver for named Agent '${name}' returned an invalid structured argv.`);
  }
  return [...launch];
}

function copyArgv(argv: readonly [string, ...string[]]): [string, ...string[]] {
  return [...argv];
}

function projectAgentConfigPath(cwd: string): string {
  return join(resolve(cwd), ".acpus", "agents.json");
}

function globalAgentConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, ".acpus", "agents.json") : undefined;
}

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function canonicalAgentName(name: string): string {
  return Object.hasOwn(BUILT_IN_AGENT_ALIASES, name) ? BUILT_IN_AGENT_ALIASES[name]! : name;
}

function configFailure(message: string): AcpAgentResolutionFailure {
  return { type: "agent-config", message };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function agentArgv(value: unknown): value is [string, ...string[]] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(argument => typeof argument === "string")
    && value[0]!.trim().length > 0;
}

function isNotFound(error: unknown): boolean {
  const code = record(error) ? error.code : undefined;
  return code === "ENOENT";
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
