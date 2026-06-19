import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileWorkflow } from "@acpus/core";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { ArtifactStore } from "../../src/artifacts.js";
import type { NodeExecutionState } from "../../src/types.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mockAgentEntry = require.resolve("@acpus/mock-agent");

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const homeDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups.length = 0;
  for (const h of homeDirs) {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  homeDirs.length = 0;
});

/** Create an isolated HOME directory so acpx session metadata never leaks. */
function makeIsolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "acpus-e2e-home-"));
  homeDirs.push(home);
  return home;
}

/** Poll `predicate` until true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

function readArtifactBySuffix(
  store: { getBaseDir(): string },
  runId: string,
  node: NodeExecutionState,
  suffix: string
): string {
  const ref = node.artifactRefs?.find((u) => u.endsWith(suffix));
  expect(ref).toBeDefined();
  return new ArtifactStore(store.getBaseDir()).read(runId, node.nodeKey, suffix).toString();
}

// ---------------------------------------------------------------------------
// ACP lifecycle helpers (cancel/resume/retry)
// ---------------------------------------------------------------------------

interface Sandbox {
  home: string;
  work: string;
  scriptPath: string;
  tracePath: string;
  cleanup: () => void;
}

function makeSandbox(scriptYaml: string): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "acpus-e2e-home-"));
  homeDirs.push(home);
  const work = mkdtempSync(join(tmpdir(), "acpus-e2e-work-"));
  const scriptPath = join(work, "mock.yaml");
  const tracePath = join(work, "mock-trace.jsonl");
  writeFileSync(scriptPath, scriptYaml);
  const cleanup = () => {
    rmSync(work, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { home, work, scriptPath, tracePath, cleanup };
}

/** Build the acpx `command` that launches our Mock Agent. */
function agentCommand(scriptPath: string, tracePath: string): string {
  return `${process.execPath} ${mockAgentEntry} --script ${scriptPath} --trace ${tracePath} --trace-mode overwrite`;
}

/** Build an agent workflow whose single step is driven by acpx + Mock Agent. */
function agentWorkflow(name: string, sandbox: Sandbox, prompt: string): ReturnType<typeof compileYaml> {
  return compileYaml(`
version: 1
name: ${name}
agents:
  worker:
    type: command
    use: "${agentCommand(sandbox.scriptPath, sandbox.tracePath)}"
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

async function waitForTraceEvent(
  tracePath: string,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 8000
): Promise<void> {
  await waitFor(() => {
    if (!existsSync(tracePath)) return false;
    return readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          return predicate(JSON.parse(line) as Record<string, unknown>);
        } catch {
          return false;
        }
      });
  }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Composite fanout→loop helpers
// ---------------------------------------------------------------------------

const fixtures = join(import.meta.dirname, "../../../core/test/fixtures");
const fixturePath = join(fixtures, "composite-e2e/workflow.yaml");

/** Read and patch the fixture workflow for E2E: absolute mock-agent path, HOME isolation, trace redirect. */
function patchWorkflowSource(home: string): string {
  const mockScriptPath = join(fixtures, "composite-e2e/mock.yaml");
  const tracePath = join(home, "mock-trace.jsonl");
  return readFileSync(fixturePath, "utf8")
    .replace(
      /use: "node \.\/packages\/mock-agent\/dist\/index\.js --script \.\/packages\/core\/test\/fixtures\/composite-e2e\/mock\.yaml"/,
      `use: "${process.execPath} ${mockAgentEntry} --script ${mockScriptPath} --trace ${tracePath} --trace-mode overwrite"`
    )
    .replace(
      /cwd: "\."/,
      `cwd: "."\n    env:\n      HOME: "${home}"`
    );
}

// ===========================================================================
// Test suites
// ===========================================================================

describe("E2E: real acpx agent", () => {
  beforeAll(() => {
    // Ensure acpx is resolvable; the mock-agent entry is resolved at load time.
    require.resolve("acpx/package.json");
  });

  // -----------------------------------------------------------------------
  describe("ACP lifecycle (cancel/resume/retry)", () => {
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
      const ir = agentWorkflow("e2e-basic", sandbox, "hello agent");
      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      const meta = await interpreter.start(ir, { input: {} });
      expect(meta.status).toBe("completed");

      const task = store.listNodeStates(meta.runId).find((n) => n.nodeId === "task");
      expect(task?.state).toBe("completed");
      // Envelope: { output: { text } }.
      expect((task?.output as { output: { text: string } }).output.text).toContain("hi there");

      const telemetry = JSON.parse(readArtifactBySuffix(store, meta.runId, task!, "attempt-001.telemetry.json")) as { state: string; output?: { preview?: string } };
      expect(telemetry.state).toBe("completed");
      expect(telemetry.output?.preview).toContain("hi there");
      expect(task?.agentTelemetry?.attempts[0]?.state).toBe("completed");
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
      const ir = agentWorkflow("e2e-cancel", sandbox, "please hang now");
      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      // Start the run; it will block on the hanging agent turn.
      const runId = "e2e-cancel-run";
      const runPromise = interpreter.start(ir, { input: {}, runId });

      await waitFor(() => store.readNodeState(runId, NODE_KEY)?.state === "running", 8000);
      await waitForTraceEvent(sandbox.tracePath, (event) => event.event === "hang" && event.ruleName === "hang");
      interpreter.pauseRun(runId);

      const meta = await runPromise;
      expect(meta.status).toBe("paused");

      const task = store.listNodeStates(runId).find((n) => n.nodeId === "task");
      expect(task?.state).toBe("paused");

      const telemetry = JSON.parse(readArtifactBySuffix(store, runId, task!, "attempt-001.telemetry.json")) as { state: string };
      expect(telemetry.state).toBe("paused");
      expect(task?.agentTelemetry?.attempts[0]?.state).toBe("paused");
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
      const ir = agentWorkflow("e2e-resume", sandbox, "start work");
      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      const runId = "e2e-resume-run";
      const runPromise = interpreter.start(ir, { input: {}, runId });

      // Pause mid-turn → node paused.
      await waitFor(() => store.readNodeState(runId, NODE_KEY)?.state === "running", 8000);
      await waitForTraceEvent(sandbox.tracePath, (event) => event.event === "hang" && event.ruleName === "hang-first");
      interpreter.pauseRun(runId);
      const paused = await runPromise;
      expect(paused.status).toBe("paused");
      const pausedTask = store.readNodeState(runId, NODE_KEY);
      expect(pausedTask?.state).toBe("paused");
      expect(pausedTask?.error).toBe("Aborted: paused");

      // Run-level resume sends the fixed continuation prompt for the paused Agent Step.
      await interpreter.resumeRun(runId);
      const resumed = await interpreter.runToCompletion(ir, { input: {}, runId }, runId);
      expect(resumed.status).toBe("completed");
      const task = store.readNodeState(runId, NODE_KEY);
      expect(task?.state).toBe("completed");
      expect(task?.error).toBeUndefined();
      expect(task?.attempt).toBe(2);
      expect((task?.output as { output: { text: string } }).output.text).toContain("resumed and finished");

      // The continuation prompt artifact proves the fixed continuation prompt was sent.
      const prompt = readArtifactBySuffix(store, runId, task!, "attempt-002.prompt.md");
      expect(prompt).toContain("Continue the previous task from where you left off.");
      const telemetry = JSON.parse(readArtifactBySuffix(store, runId, task!, "attempt-002.telemetry.json")) as { state: string; output?: { preview?: string } };
      expect(telemetry.state).toBe("completed");
      expect(telemetry.output?.preview).toContain("resumed and finished");
    }, 25000);

    it("scenario #2b: continuation prompt uses mock session history for schema-correct output", async () => {
      const sandbox = makeSandbox(`
version: 1
agent_id: e2e-review-continuation
default_response:
  type: text
  text: "default"
rules:
  - name: review
    when:
      prompt_contains: "branch=review"
    respond:
      type: json
      payload:
        branch: review
        lane: fixture
        ok: true
      stream:
        chunks: 2
        chunk_interval: 0ms
      hang_after_chunks: 1
  - name: loop-continuation
    when:
      prompt_contains: "Continue the previous task"
      previous_rule: loop
    respond:
      type: json
      payload:
        branch: loop
        round: 0
        continue: true
  - name: review-continuation
    when:
      prompt_contains: "Continue the previous task"
      previous_rule: review
    respond:
      type: json
      payload:
        branch: review
        lane: fixture
        ok: true
`);
      const ir = compileYaml(`
version: 1
name: e2e-review-continuation
agents:
  worker:
    type: command
    use: "${agentCommand(sandbox.scriptPath, sandbox.tracePath)}"
    cwd: "${sandbox.work}"
    env:
      HOME: "${sandbox.home}"
workflow:
  steps:
    - id: task
      run: agent
      use: worker
      prompt: "Transcript branch=review"
      output:
        branch: string
        lane: string
        ok: boolean
`);
      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      const runId = "e2e-review-continuation-run";
      const runPromise = interpreter.start(ir, { input: {}, runId });
      await waitFor(() => store.readNodeState(runId, NODE_KEY)?.state === "running", 8000);
      await waitForTraceEvent(sandbox.tracePath, (event) => event.event === "session/update" && event.ruleName === "review");
      interpreter.pauseRun(runId);
      const paused = await runPromise;
      expect(paused.status).toBe("paused");

      await interpreter.resumeRun(runId);
      const resumed = await interpreter.runToCompletion(ir, { input: {}, runId }, runId);
      expect(resumed.status).toBe("completed");
      const task = store.readNodeState(runId, NODE_KEY);
      expect(task?.state).toBe("completed");
      expect(task?.output).toEqual({ output: { branch: "review", lane: "fixture", ok: true } });

      const response = readArtifactBySuffix(store, runId, task!, "attempt-002.response.md");
      expect(response).toBe('{"branch":"review","lane":"fixture","ok":true}');
    }, 25000);

    it("scenario #3: dead agent subprocess is recovered by acpx on Node-level retry", async () => {
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
      const ir = agentWorkflow("e2e-crash", sandbox, "do work");
      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      // First attempt: the agent subprocess crashes mid-turn → node fails.
      const runId = "e2e-crash-run";
      const meta = await interpreter.start(ir, { input: {}, runId });
      expect(meta.status).toBe("failed");
      expect(store.readNodeState(runId, NODE_KEY)?.state).toBe("failed");

      // Retry re-runs the Activity; acpx respawns and loads the saved session,
      // and the continuation prompt completes against the recovered agent.
      await interpreter.retryNode(runId, NODE_KEY);
      const task = store.readNodeState(runId, NODE_KEY);
      expect(task?.state).toBe("completed");
      expect((task?.output as { output: { text: string } }).output.text).toContain("recovered");
    }, 20000);
  });

  // -----------------------------------------------------------------------
  describe("composite fanout→loop (session isolation + artifacts)", () => {
    it("reuses session_key across loop materializations while keeping distinct node keys", async () => {
      const sandbox = makeSandbox(`
version: 1
agent_id: e2e-session-key-loop
default_response:
  type: json
  payload:
    ok: false
rules:
  - name: first-round
    when:
      prompt_contains: "round=0"
    respond:
      type: json
      payload:
        ok: false
  - name: second-round-same-session
    when:
      prompt_contains: "round=1"
      previous_rule: first-round
    respond:
      type: json
      payload:
        ok: true
`);
      const ir = compileYaml(`
version: 1
name: e2e-session-key-loop
agents:
  worker:
    type: command
    use: "${agentCommand(sandbox.scriptPath, sandbox.tracePath)}"
    cwd: "${sandbox.work}"
    env:
      HOME: "${sandbox.home}"
workflow:
  steps:
    - id: fix_loop
      loop:
        until: loop.last.output.ok == true
        max_iterations: 2
        do:
          - id: fix_once
            run: agent
            use: worker
            session_key: "fix-loop"
            prompt: "fix round=\${{ loop.iter }}"
            output:
              ok: boolean
`);
      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      const meta = await interpreter.start(ir, { input: {} });
      expect(meta.status).toBe("completed");

      const fixNodes = store.listNodeStates(meta.runId)
        .filter((n) => n.nodeId === "fix_once")
        .sort((a, b) => Number(a.nodeKey.match(/round:(\d+)/)?.[1]) - Number(b.nodeKey.match(/round:(\d+)/)?.[1]));
      expect(fixNodes).toHaveLength(2);
      expect(fixNodes[0]?.nodeKey).toContain("round:0");
      expect(fixNodes[1]?.nodeKey).toContain("round:1");
      expect(fixNodes[0]?.output).toEqual({ output: { ok: false } });
      expect(fixNodes[1]?.output).toEqual({ output: { ok: true } });

      const firstPrompt = readArtifactBySuffix(store, meta.runId, fixNodes[0]!, "attempt-001.prompt.md");
      const secondPrompt = readArtifactBySuffix(store, meta.runId, fixNodes[1]!, "attempt-001.prompt.md");
      expect(firstPrompt).toContain("fix round=0");
      expect(secondPrompt).toContain("fix round=1");
      expect(secondPrompt).not.toContain("Continue the previous task");
    }, 30_000);

    it("executes fanout→loop through real acpx with session isolation", async () => {
      const home = makeIsolatedHome();
      const source = patchWorkflowSource(home);
      const compiled = compileWorkflow(source, { sourcePath: fixturePath });
      expect(compiled.ok).toBe(true);
      const ir = compiled.ir!;

      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      const meta = await interpreter.start(ir, { input: { items: ["alpha", "skip"], max_rounds: 1 } });
      expect(meta.status).toBe("completed");

      const nodes = store.listNodeStates(meta.runId);

      const workNodes = nodes.filter((n) => n.nodeId === "work");
      expect(workNodes).toHaveLength(1);
      expect(workNodes[0]?.state).toBe("completed");
      expect(workNodes[0]?.nodeKey).toContain("item:alpha");

      const telemetry = JSON.parse(readArtifactBySuffix(store, meta.runId, workNodes[0]!, "attempt-001.telemetry.json")) as { state: string };
      expect(telemetry.state).toBe("completed");

      const skippedGuard = nodes.find((n) => n.nodeId === "skip_lane" && n.nodeKey.includes("item:skip"));
      expect(skippedGuard?.state).toBe("completed");
      expect(nodes.some((n) => n.nodeId === "work" && n.nodeKey.includes("item:skip"))).toBe(false);

      const fanoutNode = nodes.find((n) => n.nodeId === "composite");
      expect(fanoutNode?.state).toBe("completed");
    }, 30_000);
  });
});
