import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createManagedAcpExecutor,
  type AgentSelector,
  type AgentTurnObservation,
  type AgentTurnRequest,
  type AgentTurnResult,
  type ManagedAcpAttempt,
} from "@acpus/agent-executor";

const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe.concurrent("managed Acpx Agent resolution", () => {
  it("uses effective HOME and resolves once before handing off the attempt", async () => {
    const fixture = await managedFixture();
    await writeAgentConfig(fixture.configPath, "claude", "first response");

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-1", "session-1", named("claude")), async attempt => {
      await writeAgentConfig(fixture.configPath, "claude", "second response");
      expect(await attempt.runTurn(turnRequest(fixture, "session-1", named("claude")))).toMatchObject({
        status: "completed",
        finalResponse: "first response|1",
      });
    });

    expect(await readdir(fixture.workersRoot)).toEqual([]);
  });

  it("preserves terminal facts across late tool updates on consecutive turns", async () => {
    const fixture = await managedFixture();
    await writeAgentConfig(fixture.configPath, "claude", "response", ["live-breakdown", "late-tool-update"]);
    const firstObservations: AgentTurnObservation[] = [];
    const secondObservations: AgentTurnObservation[] = [];

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-usage", "session-usage", named("claude")), async attempt => {
      const first = await attempt.runTurn({
        ...turnRequest(fixture, "session-usage", named("claude")),
        onObservation: observation => firstObservations.push(observation),
      });
      const second = await attempt.runTurn({
        ...turnRequest(fixture, "session-usage", named("claude")),
        onObservation: observation => secondObservations.push(observation),
      });

      expect(first.summary).toMatchObject({
        context: { used: 12, size: 100 },
        tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        tools: {
          totalToolCallCount: 1,
          calls: [{ toolCallId: "fixture-tool-1", status: "completed" }],
        },
      });
      expect(first).toMatchObject({
        status: "completed",
        responses: ["response|1"],
        finalResponse: "response|1",
      });
      expect(second.summary).toMatchObject({
        context: { used: 23, size: 100 },
        tokenUsage: { source: "prompt_response", inputTokens: 20, outputTokens: 3, totalTokens: 23 },
        tools: {
          totalToolCallCount: 1,
          calls: [{ toolCallId: "fixture-tool-2", status: "completed" }],
        },
      });
      expect(second).toMatchObject({
        status: "completed",
        responses: ["response|1"],
        finalResponse: "response|1",
      });
    });

    expect(firstObservations.filter(observation => observation.event.type === "usage")).toHaveLength(1);
    expect(firstObservations.at(-1)).toMatchObject({
      event: { type: "turn_end", status: "completed" },
      progress: {
        summary: {
          tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      },
    });
    expect(secondObservations.find(observation => observation.event.type === "usage")).toMatchObject({
      event: {
        type: "usage",
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    });
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
      owner: { generation: "test" },
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

async function writeAgentConfig(path: string, name: string, response: string, flags: string[] = []): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    agents: {
      [name]: { argv: [process.execPath, fixtureAgent, response, ...flags] },
    },
  })}\n`, "utf8");
}
