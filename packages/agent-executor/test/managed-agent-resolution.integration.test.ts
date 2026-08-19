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

describe.concurrent("managed Acpus Agent resolution", () => {
  it("uses effective HOME and resolves once before handing off the attempt", async () => {
    const fixture = await managedFixture();
    await writeAgentConfig(fixture.configPath, "claude", "first response");

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-1", "session-1", named("claude")), async attempt => {
      await writeAgentConfig(fixture.configPath, "claude", "second response");
      for (let turn = 0; turn < 2; turn += 1) {
        expect(await attempt.runTurn(turnRequest(fixture, "session-1", named("claude")))).toMatchObject({
          status: "completed",
          finalResponse: "first response",
        });
      }
    });
    expect(await readdir(fixture.workersRoot)).toEqual([]);

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-2", "session-2", named("claude")), async attempt => {
      expect(await attempt.runTurn(turnRequest(fixture, "session-2", named("claude")))).toMatchObject({
        status: "completed",
        finalResponse: "second response",
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
        responses: ["response"],
        finalResponse: "response",
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
        responses: ["response"],
        finalResponse: "response",
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

  it("isolates asynchronous observers and drains cancellation before another turn", async () => {
    const fixture = await managedFixture();
    const gate = join(fixture.cwd, "cancel-gate");
    fixture.env.ACP_FIXTURE_GATE_DIRECTORY = gate;
    await writeAgentConfig(fixture.configPath, "claude", "response", ["late-cancel-first", "gate-cancel"]);

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-cancel-drain", "session-cancel-drain", named("claude")), async attempt => {
      const controller = new AbortController();
      let observe!: () => void;
      const observed = new Promise<void>(resolve => { observe = resolve; });
      const first = attempt.runTurn({
        ...turnRequest(fixture, "session-cancel-drain", named("claude")),
        signal: controller.signal,
        onProgress: async () => { throw new Error("progress observer failed"); },
        onObservation: () => {
          observe();
          return new Promise(() => {});
        },
      });
      await observed;
      controller.abort();
      expect(await first).toMatchObject({ status: "cancelled" });
      await waitForPath(join(gate, "cancel.started"));

      const whileDraining = await attempt.runTurn(turnRequest(fixture, "session-cancel-drain", named("claude")));
      expect(whileDraining).toMatchObject({
        status: "failed",
        failure: { kind: "worker_lost", message: "ACP worker already has an active turn." },
      });
      await writeFile(join(gate, "cancel.release"), "");
      await new Promise(resolve => setTimeout(resolve, 20));
      const afterDrain = await attempt.runTurn(turnRequest(fixture, "session-cancel-drain", named("claude")));
      expect(afterDrain).toMatchObject({ status: "completed", finalResponse: "response" });
    });
  });

  it("resumes the same projected session in a later worker attempt", async () => {
    const fixture = await managedFixture();
    await writeAgentConfig(fixture.configPath, "resumable", "restart response", ["resume-session", "echo-session"]);
    let projectionPath: string | undefined;

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-new", "session-restart", named("resumable")), async attempt => {
      const result = await attempt.runTurn(turnRequest(fixture, "session-restart", named("resumable")));
      expect(result).toMatchObject({
        status: "completed",
        finalResponse: "restart response|new|fixture-session",
        summary: { sessionProjectionPath: "sessions/session-restart.json" },
      });
      projectionPath = result.summary.sessionProjectionPath;
    });
    expect(await readdir(fixture.workersRoot)).toEqual([]);

    await fixture.executor.withAttempt(attemptInput(fixture, "attempt-resume", "session-restart", named("resumable")), async attempt => {
      const result = await attempt.runTurn(turnRequest(fixture, "session-restart", named("resumable")));
      expect(result).toMatchObject({
        status: "completed",
        responses: ["restart response|resume|fixture-session"],
        finalResponse: "restart response|resume|fixture-session",
      });
      expect(result.summary.sessionProjectionPath).toBe(projectionPath);
    });
    expect(await readdir(fixture.workersRoot)).toEqual([]);
  });

  it("returns a non-retryable runtime config failure without creating ownership", async () => {
    const fixture = await managedFixture();
    await writeFile(fixture.configPath, "{ invalid", "utf8");
    await mkdir(fixture.workersRoot);
    const callbackFailure = new Error("caller failure");
    let result: AgentTurnResult | undefined;
    const use = vi.fn(async (attempt: ManagedAcpAttempt) => {
      expect(await readdir(fixture.workersRoot)).toEqual([]);
      result = await attempt.runTurn(turnRequest(fixture, "session-invalid", named("configured")));
      expect(await readdir(fixture.workersRoot)).toEqual([]);
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
    expect(result).not.toHaveProperty("finalResponse");
    expect(result?.status === "failed" ? result.failure.message : "").toContain("Invalid Agent config");
    expect(use).toHaveBeenCalledOnce();
    expect(await readdir(fixture.workersRoot)).toEqual([]);
  });
});

async function managedFixture() {
  const root = await mkdtemp(join(tmpdir(), "acpus-managed-agent-resolution-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const workersRoot = join(root, "workers");
  const configPath = join(home, ".acpus", "agents.json");
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

async function waitForPath(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}
