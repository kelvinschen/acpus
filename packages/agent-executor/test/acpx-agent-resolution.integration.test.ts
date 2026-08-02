import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAcpxAgentLaunch, type AcpxAgentLaunch } from "../src/acpx-agent-resolution.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("pinned Acpx named Agent resolution", () => {
  it("lets effective cwd config override the global built-in mapping", async () => {
    const fixture = await configFixture();
    await writeConfig(fixture.globalConfig, {
      agents: {
        codex: { command: "global-acp" },
      },
    });
    await writeConfig(fixture.projectConfig, {
      agents: {
        codex: { argv: ["project acp", "--stdio"] },
      },
    });

    await expectResolved("codex", fixture, ["project acp", "--stdio"]);
  });

  it("returns explicit commands without consulting cwd or Acpx config", async () => {
    const result = await resolveAcpxAgentLaunch({
      agent: { kind: "command", command: "custom-acp --stdio" },
      cwd: join(tmpdir(), "acpus-does-not-exist"),
      env: {},
    });

    expect(result._unsafeUnwrap()).toBe("custom-acp --stdio");
  });
});

async function configFixture(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  globalConfig: string;
  projectConfig: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "acpus-acpx-agent-resolution-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await Promise.all([
    mkdir(join(home, ".acpx"), { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  return {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    globalConfig: join(home, ".acpx", "config.json"),
    projectConfig: join(cwd, ".acpxrc.json"),
  };
}

async function writeConfig(path: string, config: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(config)}\n`, "utf8");
}

async function expectResolved(
  name: string,
  fixture: Awaited<ReturnType<typeof configFixture>>,
  expected: AcpxAgentLaunch,
): Promise<void> {
  const result = await resolveAcpxAgentLaunch({
    agent: { kind: "named", name },
    cwd: fixture.cwd,
    env: fixture.env,
  });
  expect(result._unsafeUnwrap()).toEqual(expected);
}
