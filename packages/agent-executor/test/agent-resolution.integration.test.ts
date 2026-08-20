import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import {
  AcpAgentResolutionSystemError,
  resolveAcpAgentLaunch,
  resolveNamedAcpAgentLaunch,
} from "../src/agent-resolution.js";

const builtInAgents = {
  pi: ["npx", "pi-acp@^0.0.31"],
  openclaw: ["openclaw", "acp"],
  codex: ["npx", "-y", "@agentclientprotocol/codex-acp@^1.1.5"],
  claude: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@^0.60.0"],
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
  mux: ["npx", "-y", "mux@^0.28.0", "acp"],
  opencode: ["npx", "-y", "opencode-ai", "acp"],
  pool: ["pool", "acp"],
  qoder: ["qodercli", "--acp"],
  qwen: ["qwen", "--acp"],
  trae: ["traecli", "acp", "serve"],
  zeroclaw: ["zeroclaw", "acp"],
} as const;

describe("Acpus named Agent resolution", () => {
  it.each(Object.entries(builtInAgents))("owns the %s built-in launch", async (name, expected) => {
    expect((await resolveNamedAcpAgentLaunch({ name }))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: expected,
      name,
    });
  });

  it.each(["factory-droid", "factorydroid"])("resolves the %s alias to droid", async name => {
    expect((await resolveNamedAcpAgentLaunch({ name }))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: builtInAgents.droid,
      name,
    });
  });

  it("checks an exact configured alias before its canonical name", async () => {
    const configuredAgentCommand = vi.fn((names: readonly string[]) => okAsync(
      names.includes("factorydroid") ? "exact --stdio" : undefined,
    ));

    expect((await resolveNamedAcpAgentLaunch({ name: " FACTORYDROID ", configuredAgentCommand }))._unsafeUnwrap()).toEqual({
      kind: "command",
      command: "exact --stdio",
      name: "factorydroid",
    });
    expect(configuredAgentCommand).toHaveBeenCalledTimes(1);
    expect(configuredAgentCommand).toHaveBeenCalledWith(["factorydroid", "droid"]);
  });

  it("lets configured commands override a built-in", async () => {
    const configuredAgentCommand = (names: readonly string[]) => okAsync(names.includes("codex") ? "configured-codex --stdio" : undefined);

    expect((await resolveNamedAcpAgentLaunch({ name: " CODEX ", configuredAgentCommand }))._unsafeUnwrap()).toEqual({
      kind: "command",
      command: "configured-codex --stdio",
      name: "codex",
    });
  });

  it("propagates configured resolver failures", async () => {
    const result = await resolveNamedAcpAgentLaunch({
      name: "codex",
      configuredAgentCommand: () => errAsync({ type: "agent-config", message: "config invalid" }),
    });

    expect(result._unsafeUnwrapErr()).toEqual({ type: "agent-config", message: "config invalid" });
  });

  it("returns a config failure for an unknown or empty name", async () => {
    expect((await resolveNamedAcpAgentLaunch({ name: "not-configured" }))._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining("not-configured"),
    });
    expect((await resolveNamedAcpAgentLaunch({ name: " \t " }))._unsafeUnwrapErr()).toEqual({
      type: "agent-config",
      message: "Named Agent name must contain a non-whitespace character.",
    });
  });

  it("lets explicit commands and Host launches bypass configured resolution", async () => {
    const configuredAgentCommand = vi.fn(() => errAsync({ type: "agent-config" as const, message: "must not run" }));
    const host = vi.fn(({ model }: { model?: string }) => ["host-agent", model ?? "default"]);

    expect((await resolveAcpAgentLaunch({
      agent: { kind: "command", command: "explicit-agent --stdio" },
      namedAgentLaunches: { host },
      configuredAgentCommand,
    }))._unsafeUnwrap()).toEqual({ kind: "command", command: "explicit-agent --stdio" });
    expect((await resolveAcpAgentLaunch({
      agent: { kind: "named", name: " HOST " },
      model: "selected-model",
      namedAgentLaunches: { host },
      configuredAgentCommand,
    }))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["host-agent", "selected-model"],
      name: "host",
    });
    expect(configuredAgentCommand).not.toHaveBeenCalled();
  });

  it("ignores inherited Host entries and rejects invalid own launches", async () => {
    const inherited = vi.fn(() => ["inherited-host"]);
    const namedAgentLaunches = Object.create({ custom: inherited }) as Record<string, typeof inherited>;
    expect((await resolveAcpAgentLaunch({
      agent: { kind: "named", name: "custom" },
      namedAgentLaunches,
    }))._unsafeUnwrapErr()).toMatchObject({ type: "agent-config" });
    expect(inherited).not.toHaveBeenCalled();

    expect(() => resolveAcpAgentLaunch({
      agent: { kind: "named", name: "host" },
      namedAgentLaunches: { host: () => [] },
    })).toThrow(AcpAgentResolutionSystemError);
  });
});
