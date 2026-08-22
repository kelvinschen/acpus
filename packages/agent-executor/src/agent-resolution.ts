import * as Effect from "effect/Effect";
import type {
  AcpAgentLaunch,
  AgentSelector,
  ConfiguredAcpAgentCommandResolver,
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

export class AcpAgentResolutionSystemError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpAgentResolutionSystemError";
  }
}

export function resolveAcpAgentLaunch(input: {
  agent: AgentSelector;
  model?: string;
  namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
  configuredAgentCommand?: ConfiguredAcpAgentCommandResolver;
}): Effect.Effect<AcpAgentLaunch, AcpAgentResolutionFailure> {
  return Effect.suspend<AcpAgentLaunch, AcpAgentResolutionFailure, never>(() => {
    if (input.agent.kind === "command") {
      return Effect.succeed<AcpAgentLaunch>({ kind: "command", command: input.agent.command });
    }

    const name = normalizeAgentName(input.agent.name);
    if (!name) return Effect.fail(configFailure("Named Agent name must contain a non-whitespace character."));

    if (input.namedAgentLaunches !== undefined && Object.hasOwn(input.namedAgentLaunches, name)) {
      return Effect.succeed({
        kind: "argv",
        argv: resolveHostAgentLaunch(input.namedAgentLaunches[name], name, input.model),
        name,
      });
    }

    return resolveNamedAcpAgentLaunch({
      name,
      ...(input.configuredAgentCommand === undefined
        ? {}
        : { configuredAgentCommand: input.configuredAgentCommand }),
    });
  });
}

export function resolveNamedAcpAgentLaunch(input: {
  name: string;
  configuredAgentCommand?: ConfiguredAcpAgentCommandResolver;
}): Effect.Effect<AcpAgentLaunch, AcpAgentResolutionFailure> {
  return Effect.suspend<AcpAgentLaunch, AcpAgentResolutionFailure, never>(() => {
    const name = normalizeAgentName(input.name);
    if (!name) return Effect.fail(configFailure("Named Agent name must contain a non-whitespace character."));
    const canonical = canonicalAgentName(name);
    const configured: Effect.Effect<string | undefined, AcpAgentResolutionFailure> = input.configuredAgentCommand === undefined
      ? Effect.succeed<string | undefined>(undefined)
      : input.configuredAgentCommand(canonical === name ? [name] : [name, canonical]);

    return configured.pipe(Effect.flatMap(command => {
      if (command !== undefined) return Effect.succeed<AcpAgentLaunch>({ kind: "command", command, name });

      const builtIn = resolveBuiltInAgent(name);
      if (builtIn !== undefined) return Effect.succeed<AcpAgentLaunch>({ kind: "argv", argv: copyArgv(builtIn), name });

      return Effect.fail(configFailure(
        `Named Agent '${name}' is not configured or built in. Configure it in Acpus config or use an explicit command selector.`,
      ));
    }));
  });
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

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function canonicalAgentName(name: string): string {
  return Object.hasOwn(BUILT_IN_AGENT_ALIASES, name) ? BUILT_IN_AGENT_ALIASES[name]! : name;
}

function configFailure(message: string): AcpAgentResolutionFailure {
  return { type: "agent-config", message };
}

function agentArgv(value: unknown): value is [string, ...string[]] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(argument => typeof argument === "string")
    && value[0]!.trim().length > 0;
}
