import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpAgentResolutionSystemError,
  resolveAcpAgentLaunch,
  resolveNamedAcpAgentLaunch,
} from "../src/agent-resolution.js";

const temporaryDirectories: string[] = [];

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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Acpus named Agent resolution", () => {
  it.each(Object.entries(builtInAgents))("owns the %s built-in launch", async (name, expected) => {
    const fixture = await configFixture();

    const result = await resolveNamed(name, fixture);

    expect(result._unsafeUnwrap()).toEqual({ kind: "argv", argv: expected, name });
  });

  it.each(["factory-droid", "factorydroid"])("resolves the %s alias to droid", async name => {
    const fixture = await configFixture();

    expect((await resolveNamed(name, fixture))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: builtInAgents.droid,
      name,
    });
  });

  it("checks a project canonical alias before an exact global alias", async () => {
    const fixture = await configFixture();
    await writeConfig(fixture.globalConfig, {
      agents: { factorydroid: { argv: ["global-exact"] } },
    });
    await writeConfig(fixture.projectConfig, {
      agents: { droid: { argv: ["project-canonical"] } },
    });

    expect((await resolveNamed(" FACTORYDROID ", fixture))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["project-canonical"],
      name: "factorydroid",
    });
  });

  it("checks an exact alias before its canonical name within one source", async () => {
    const fixture = await configFixture();
    await writeConfig(fixture.projectConfig, {
      agents: {
        factorydroid: { argv: ["exact-alias"] },
        droid: { argv: ["canonical-alias"] },
      },
    });

    expect((await resolveNamed("factorydroid", fixture))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["exact-alias"],
      name: "factorydroid",
    });
  });

  it("lets normalized project config override global config and a built-in", async () => {
    const fixture = await configFixture();
    await writeConfig(fixture.globalConfig, { agents: { codex: { argv: ["global-codex"] } } });
    await writeConfig(fixture.projectConfig, { agents: { " CoDeX ": { argv: ["project-codex"] } } });

    expect((await resolveNamed(" CODEX ", fixture))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["project-codex"],
      name: "codex",
    });
  });

  it("returns a config failure for an unknown name instead of treating it as a command", async () => {
    const fixture = await configFixture();

    const result = await resolveNamed("not-configured", fixture);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining("not-configured"),
    });
  });

  it("returns a config failure for an empty normalized selector", async () => {
    const fixture = await configFixture();

    const result = await resolveNamed(" \t ", fixture);

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "agent-config",
      message: "Named Agent name must contain a non-whitespace character.",
    });
  });

  it.each(["global", "project"] as const)("returns a typed failure for malformed %s config", async source => {
    const fixture = await configFixture();
    await writeFile(source === "global" ? fixture.globalConfig : fixture.projectConfig, "{ invalid", "utf8");

    const result = await resolveNamed("codex", fixture);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining(source === "global" ? fixture.globalConfig : fixture.projectConfig),
    });
  });

  it("validates every entry in each present config before resolving", async () => {
    const fixture = await configFixture();
    await writeConfig(fixture.globalConfig, {
      agents: { unrelated: { command: "invalid" } },
    });
    await writeConfig(fixture.projectConfig, {
      agents: { codex: { argv: ["project-codex"] } },
    });

    const result = await resolveNamed("codex", fixture);

    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "agent-config" });
  });

  it("returns a typed failure when a present config cannot be read", async () => {
    const fixture = await configFixture();
    await mkdir(fixture.projectConfig);

    const result = await resolveNamed("codex", fixture);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining(fixture.projectConfig),
    });
  });

  it("returns a typed failure when the config directory path is not a directory", async () => {
    const fixture = await configFixture();
    await rm(dirname(fixture.projectConfig), { recursive: true });
    await writeFile(dirname(fixture.projectConfig), "not a directory", "utf8");

    const result = await resolveNamed("codex", fixture);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "agent-config",
      message: expect.stringContaining(fixture.projectConfig),
    });
  });

  it("resolves each attempt against current config", async () => {
    const fixture = await configFixture();
    await writeConfig(fixture.projectConfig, { agents: { custom: { argv: ["first"] } } });
    expect((await resolveNamed("custom", fixture))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["first"],
      name: "custom",
    });

    await writeConfig(fixture.projectConfig, { agents: { custom: { argv: ["second"] } } });
    expect((await resolveNamed("custom", fixture))._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["second"],
      name: "custom",
    });
  });

  it("lets an explicit command bypass host and malformed config", async () => {
    const fixture = await configFixture();
    await writeFile(fixture.projectConfig, "{ invalid", "utf8");
    const host = vi.fn(() => ["host-agent"]);

    const result = await resolveAcpAgentLaunch({
      agent: { kind: "command", command: "explicit-agent --stdio" },
      cwd: fixture.cwd,
      env: fixture.env,
      namedAgentLaunches: { host },
    });

    expect(result._unsafeUnwrap()).toEqual({ kind: "command", command: "explicit-agent --stdio" });
    expect(host).not.toHaveBeenCalled();
  });

  it("lets an own host resolver bypass malformed config and receive only the model", async () => {
    const fixture = await configFixture();
    await writeFile(fixture.projectConfig, "{ invalid", "utf8");
    const host = vi.fn(({ model }: { model?: string }) => ["host-agent", model ?? "default"]);

    const result = await resolveAcpAgentLaunch({
      agent: { kind: "named", name: " HOST " },
      cwd: fixture.cwd,
      env: fixture.env,
      model: "selected-model",
      namedAgentLaunches: { host },
    });

    expect(result._unsafeUnwrap()).toEqual({
      kind: "argv",
      argv: ["host-agent", "selected-model"],
      name: "host",
    });
    expect(host).toHaveBeenCalledWith({ model: "selected-model" });
  });

  it("does not resolve inherited host registry entries", async () => {
    const fixture = await configFixture();
    const inherited = vi.fn(() => ["inherited-host"]);
    const namedAgentLaunches = Object.create({ custom: inherited }) as Record<string, typeof inherited>;

    const result = await resolveAcpAgentLaunch({
      agent: { kind: "named", name: "custom" },
      cwd: fixture.cwd,
      env: fixture.env,
      namedAgentLaunches,
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "agent-config" });
    expect(inherited).not.toHaveBeenCalled();
  });

  it("treats an invalid host launch as a system invariant failure", async () => {
    const fixture = await configFixture();

    expect(() => resolveAcpAgentLaunch({
      agent: { kind: "named", name: "host" },
      cwd: fixture.cwd,
      env: fixture.env,
      namedAgentLaunches: { host: () => [] },
    })).toThrow(AcpAgentResolutionSystemError);
  });
});

async function configFixture(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  globalConfig: string;
  projectConfig: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "acpus-agent-resolution-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const globalConfig = join(home, ".acpus", "agents.json");
  const projectConfig = join(cwd, ".acpus", "agents.json");
  await Promise.all([mkdir(dirname(globalConfig), { recursive: true }), mkdir(dirname(projectConfig), { recursive: true })]);
  return {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    globalConfig,
    projectConfig,
  };
}

function writeConfig(path: string, config: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(config)}\n`, "utf8");
}

function resolveNamed(name: string, fixture: Awaited<ReturnType<typeof configFixture>>) {
  return resolveNamedAcpAgentLaunch({ name, cwd: fixture.cwd, env: fixture.env });
}
