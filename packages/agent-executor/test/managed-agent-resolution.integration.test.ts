import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createManagedAcpExecutor,
  type AgentSelector,
  type AgentTurnRequest,
  type AgentTurnResult,
  type ManagedAcpAttempt,
} from "@acpus/agent-executor";

const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("managed Acpx Agent resolution", () => {
  it("uses effective HOME and resolves once before handing off the attempt", async () => {
    const fixture = await managedFixture();
    await writeAgentConfig(fixture.configPath, "claude", "first");

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-1", "session-1", named("claude")), async attempt => {
      await writeAgentConfig(fixture.configPath, "claude", "second");
      expect(await attempt.runTurn(turnRequest(fixture, "session-1", named("claude")))).toMatchObject({
        status: "completed",
        finalResponse: "first|1",
      });
    });

    expect(await readdir(fixture.workersRoot)).toEqual([]);
  });

  it("returns a non-retryable runtime config failure without creating ownership", async () => {
    const fixture = await managedFixture();
    await writeFile(fixture.configPath, "{ invalid", "utf8");
    const callbackFailure = new Error("caller failure");
    let result: AgentTurnResult | undefined;
    const use = vi.fn(async (attempt: ManagedAcpAttempt) => {
      result = await attempt.runTurn(turnRequest(fixture, "session-invalid", named("configured")));
      throw callbackFailure;
    });

    await expect(fixture.executor.withAttempt(
      attemptInput(fixture, "attempt-invalid", "session-invalid", named("configured")),
      use,
    )).rejects.toBe(callbackFailure);

    expect(result).toMatchObject({
      status: "failed",
      failure: { kind: "config", origin: "runtime", retryable: false },
      responses: [],
    });
    expect(use).toHaveBeenCalledOnce();
    await expect(access(fixture.workersRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function managedFixture() {
  const root = await mkdtemp(join(tmpdir(), "acpus-managed-agent-resolution-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const workersRoot = join(root, "workers");
  const configPath = join(home, ".acpx", "config.json");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  await Promise.all([mkdir(dirname(configPath), { recursive: true }), mkdir(cwd, { recursive: true })]);
  return {
    cwd,
    workersRoot,
    configPath,
    env,
    executor: await createManagedAcpExecutor({
      workersRoot,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      daemon: { generation: "test" },
    }),
  };
}

function attemptInput(
  fixture: Awaited<ReturnType<typeof managedFixture>>,
  attemptId: string,
  sessionName: string,
  agent: AgentSelector,
) {
  return {
    runId: "run",
    attemptId,
    sessionName,
    cwd: fixture.cwd,
    env: fixture.env,
    agent,
    permissionMode: "approve-all" as const,
  };
}

function turnRequest(
  fixture: Awaited<ReturnType<typeof managedFixture>>,
  sessionName: string,
  agent: AgentSelector,
): AgentTurnRequest {
  return {
    agent,
    prompt: "respond",
    cwd: fixture.cwd,
    env: fixture.env,
    sessionName,
    permissionMode: "approve-all",
  };
}

function named(name: string): AgentSelector {
  return { kind: "named", name };
}

async function writeAgentConfig(path: string, name: string, response: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    agents: {
      [name]: { command: process.execPath, args: [fixtureAgent, response] },
    },
  })}\n`, "utf8");
}
