import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Real end-to-end coverage: Acpus → acpx → Mock Agent (ACP stdio server).
 * Exercises PRD mandatory runtime scenarios #1 (mid-turn cancel → partial
 * transcript + paused), #2 (resume in the same acpx session), and #3 (dead
 * subprocess reloaded/resumed by acpx).
 *
 * Each test gets an isolated HOME so acpx session metadata (`~/.acpx`) does
 * not leak across tests, and a private cwd for the workspace.
 */

const require = createRequire(import.meta.url);
const mockAgentEntry = require.resolve("@acpus/mock-agent");

/** Build the acpx `command` (escape hatch) that launches our Mock Agent. */
function agentCommand(scriptPath: string): string {
  return `${process.execPath} ${mockAgentEntry} --script ${scriptPath}`;
}

interface Sandbox {
  home: string;
  work: string;
  scriptPath: string;
  cleanup: () => void;
}

function makeSandbox(scriptYaml: string): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "acpus-e2e-home-"));
  const work = mkdtempSync(join(tmpdir(), "acpus-e2e-work-"));
  const scriptPath = join(work, "mock.yaml");
  writeFileSync(scriptPath, scriptYaml);
  return {
    home,
    work,
    scriptPath,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  };
}

/** Build an agent workflow whose single step is driven by acpx + Mock Agent. */
function agentWorkflow(name: string, sandbox: Sandbox, prompt: string): ReturnType<typeof compileYaml> {
  // `env.HOME` isolates acpx session storage; `cwd` is the per-test workspace.
  return compileYaml(`
version: 1
name: ${name}
agents:
  worker:
    type: command
    use: "${agentCommand(sandbox.scriptPath)}"
    cwd: "${sandbox.work}"
    env:
      HOME: "${sandbox.home}"
workflow:
  steps:
    - id: task
      run: agent
      use: worker
      prompt: "${prompt}"
`);
}

const NODE_KEY = "workflow/task";

describe("E2E: Agent via acpx → Mock Agent", () => {
  const sandboxes: Sandbox[] = [];
  const cleanups: Array<() => void> = [];

  beforeAll(() => {
    // Ensure acpx is resolvable; the mock-agent entry is resolved at load time.
    require.resolve("acpx/package.json");
  });

  afterEach(() => {
    cleanups.forEach((c) => c());
    sandboxes.forEach((s) => s.cleanup());
    cleanups.length = 0;
    sandboxes.length = 0;
  });

  it("runs an agent turn through acpx and returns its output (basic turn)", async () => {
    const sandbox = makeSandbox(`
version: 1
agent_id: e2e-mock
default_response:
  type: text
  text: "done"
rules:
  - name: greet
    when:
      prompt_contains: "hello"
    respond:
      type: text
      text: "hi there"
`);
    sandboxes.push(sandbox);

    const ir = agentWorkflow("e2e-basic", sandbox, "hello agent");
    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const task = store.listNodeStates(meta.runId).find((n) => n.nodeId === "task");
    expect(task?.state).toBe("completed");
    // Envelope: { output: { text } }.
    expect((task?.output as { output: { text: string } }).output.text).toContain("hi there");

    // A transcript artifact (ACP NDJSON) is always written.
    expect(task?.artifactRefs?.some((u) => u.endsWith("transcript.jsonl"))).toBe(true);
    const transcript = new ArtifactStore(store.getBaseDir()).read(meta.runId, task!.nodeKey, "transcript.jsonl").toString();
    expect(transcript).toContain("agent_message_chunk");
    expect(transcript).toContain('"stopReason":"end_turn"');
  });

  it("scenario #1: mid-turn cancel produces a partial transcript and a paused node", async () => {
    const sandbox = makeSandbox(`
version: 1
agent_id: e2e-hang
default_response:
  type: text
  text: "default"
rules:
  - name: hang
    when:
      prompt_contains: "hang"
    respond:
      type: hang
`);
    sandboxes.push(sandbox);

    const ir = agentWorkflow("e2e-cancel", sandbox, "please hang now");
    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    // Start the run; it will block on the hanging agent turn.
    const runId = "e2e-cancel-run";
    const runPromise = interpreter.start(ir, { input: {}, runId });

    // Wait until the agent node is running, then give acpx a moment to start
    // the hanging prompt turn before cooperatively pausing it mid-turn.
    await waitFor(() => store.readNodeState(runId, NODE_KEY)?.state === "running", 8000);
    await new Promise((r) => setTimeout(r, 1500));
    interpreter.pauseNode(runId, NODE_KEY);

    const meta = await runPromise;
    expect(meta.status).toBe("paused");

    const task = store.listNodeStates(runId).find((n) => n.nodeId === "task");
    expect(task?.state).toBe("paused");

    // Partial transcript artifact records the cooperative cancel.
    expect(task?.artifactRefs?.some((u) => u.endsWith("transcript.jsonl"))).toBe(true);
    const transcript = new ArtifactStore(store.getBaseDir()).read(runId, task!.nodeKey, "transcript.jsonl").toString();
    expect(transcript).toContain("session/cancel");
    expect(transcript).toContain('"stopReason":"cancelled"');
  }, 20000);

  it("scenario #2: resume continues the paused agent step with a continuation prompt", async () => {
    // First prompt hangs (so we can pause mid-turn); the fixed continuation
    // prompt that resume sends matches a rule that completes the turn.
    const sandbox = makeSandbox(`
version: 1
agent_id: e2e-resume
default_response:
  type: text
  text: "default"
rules:
  - name: hang-first
    when:
      prompt_contains: "start work"
    respond:
      type: hang
  - name: continue
    when:
      prompt_contains: "Continue the previous task"
    respond:
      type: text
      text: "resumed and finished"
`);
    sandboxes.push(sandbox);

    const ir = agentWorkflow("e2e-resume", sandbox, "start work");
    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    const runId = "e2e-resume-run";
    const runPromise = interpreter.start(ir, { input: {}, runId });

    // Pause mid-turn → node paused.
    await waitFor(() => store.readNodeState(runId, NODE_KEY)?.state === "running", 8000);
    await new Promise((r) => setTimeout(r, 1500));
    interpreter.pauseNode(runId, NODE_KEY);
    const paused = await runPromise;
    expect(paused.status).toBe("paused");
    expect(store.readNodeState(runId, NODE_KEY)?.state).toBe("paused");

    // Resume: sends the fixed continuation prompt; the node completes.
    await interpreter.resumeNode(runId, NODE_KEY);
    const task = store.readNodeState(runId, NODE_KEY);
    expect(task?.state).toBe("completed");
    expect((task?.output as { output: { text: string } }).output.text).toContain("resumed and finished");

    // The continuation transcript proves the fixed continuation prompt was sent.
    const transcript = new ArtifactStore(store.getBaseDir()).read(runId, task!.nodeKey, "transcript.jsonl").toString();
    expect(transcript).toContain("Continue the previous task from where you left off.");
    expect(transcript).toContain('"stopReason":"end_turn"');
  }, 25000);

  it("scenario #3: dead agent subprocess is recovered by acpx on resume", async () => {
    const sandbox = makeSandbox(`
version: 1
agent_id: e2e-crash
allow_unknown_session_load: true
default_response:
  type: text
  text: "recovered"
rules:
  - name: crash-on-first
    when:
      prompt_contains: "do work"
    respond:
      type: text
      text: "partial"
      crash_after_chunks: 1
      exit_code: 7
      stream:
        chunks: 4
        chunk_interval: 20ms
`);
    sandboxes.push(sandbox);

    const ir = agentWorkflow("e2e-crash", sandbox, "do work");
    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    // First attempt: the agent subprocess crashes mid-turn → node fails.
    const runId = "e2e-crash-run";
    const meta = await interpreter.start(ir, { input: {}, runId });
    expect(meta.status).toBe("failed");
    expect(store.readNodeState(runId, NODE_KEY)?.state).toBe("failed");

    // Retry re-runs the Activity; acpx respawns and resumes the saved session,
    // and the continuation prompt completes against the recovered agent.
    await interpreter.retryNode(runId, NODE_KEY);
    const task = store.readNodeState(runId, NODE_KEY);
    expect(task?.state).toBe("completed");
    expect((task?.output as { output: { text: string } }).output.text).toContain("recovered");
  }, 20000);
});

/** Poll `predicate` until true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}
