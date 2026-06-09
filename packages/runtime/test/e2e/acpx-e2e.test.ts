import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
  cleanup: () => void;
}

function makeSandbox(scriptYaml: string): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "acpus-e2e-home-"));
  homeDirs.push(home);
  const work = mkdtempSync(join(tmpdir(), "acpus-e2e-work-"));
  const scriptPath = join(work, "mock.yaml");
  writeFileSync(scriptPath, scriptYaml);
  const cleanup = () => {
    rmSync(work, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { home, work, scriptPath, cleanup };
}

/** Build the acpx `command` that launches our Mock Agent. */
function agentCommand(scriptPath: string): string {
  return `${process.execPath} ${mockAgentEntry} --script ${scriptPath}`;
}

/** Build an agent workflow whose single step is driven by acpx + Mock Agent. */
function agentWorkflow(name: string, sandbox: Sandbox, prompt: string): ReturnType<typeof compileYaml> {
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

      // Attempt-scoped transcript artifact (ACP NDJSON) is always written.
      const transcript = readArtifactBySuffix(store, meta.runId, task!, "attempt-001.transcript.jsonl");
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

      // Partial attempt-scoped transcript artifact records the cooperative cancel.
      const transcript = readArtifactBySuffix(store, runId, task!, "attempt-001.transcript.jsonl");
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

      // The continuation prompt artifact proves the fixed continuation prompt was sent.
      const prompt = readArtifactBySuffix(store, runId, task!, "attempt-002.prompt.md");
      expect(prompt).toContain("Continue the previous task from where you left off.");
      const transcript = readArtifactBySuffix(store, runId, task!, "attempt-002.transcript.jsonl");
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

  // -----------------------------------------------------------------------
  describe("composite fanout→loop (session isolation + artifacts)", () => {
    it("executes fanout→loop through real acpx with session isolation", async () => {
      const home = makeIsolatedHome();
      const source = patchWorkflowSource(home);
      const compiled = compileWorkflow(source, { sourcePath: fixturePath });
      expect(compiled.ok).toBe(true);
      const ir = compiled.ir!;

      const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
      cleanups.push(cleanup);

      const meta = await interpreter.start(ir, { input: {} });
      expect(meta.status).toBe("completed");

      const nodes = store.listNodeStates(meta.runId);

      // 1. Four work nodes, each with a unique nodeKey spanning item + lane + round dimensions
      const workNodes = nodes.filter((n) => n.nodeId === "work");
      expect(workNodes).toHaveLength(4);

      const expectedKeys = [
        "item:alpha/lane:0/round:0",
        "item:alpha/lane:0/round:1",
        "item:beta/lane:1/round:0",
        "item:beta/lane:1/round:1",
      ];
      const actualKeys = workNodes.map((n) => {
        // Extract the dimension portion after the workflow/step prefix
        const match = n.nodeKey.match(/(item:.*$)/);
        return match ? match[1] : n.nodeKey;
      }).sort();
      expect(actualKeys.sort()).toEqual(expectedKeys.sort());

      // Each work node key must contain item:, lane:, and round: dimensions
      for (const n of workNodes) {
        expect(n.nodeKey).toMatch(/item:/);
        expect(n.nodeKey).toMatch(/lane:/);
        expect(n.nodeKey).toMatch(/round:/);
      }

      // 2. Output envelope: { output: { item, round, ok } } (ACP wrapping)
      for (const n of workNodes) {
        expect(n.output).toEqual({ output: { item: "fixture", round: 0, ok: true } });
      }

      // 3. Each work node has an attempt-scoped transcript artifact.
      for (const n of workNodes) {
        const transcript = readArtifactBySuffix(store, meta.runId, n, "attempt-001.transcript.jsonl");
        expect(transcript.length).toBeGreaterThan(0);
        // Transcript should contain ACP protocol messages
        expect(transcript).toContain("agent_message_chunk");
      }

      // 4. Fanout node completed with 2 items
      const fanoutNode = nodes.find((n) => n.nodeId === "composite");
      expect(fanoutNode?.state).toBe("completed");
      expect(fanoutNode?.output).toHaveLength(2);
    }, 30_000);
  });
});
