import { compileWorkflow } from "@acpus/core";
import type { AcpusIr } from "@acpus/core";
import { RunStore } from "../../src/store.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { StubAgentExecutor } from "../support/stub-agent.js";
import type { StubAgentResponse } from "../support/stub-agent.js";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
import type { MockProgramResponse } from "../../src/executors/mock-program.js";
import { ProgramExecutor } from "../../src/executors/program.js";
import { AgentExecutor } from "../../src/executors/agent.js";
import type { InterpreterOptions, NodeExecutionState, NodeState } from "../../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function compileYaml(source: string): AcpusIr {
  const result = compileWorkflow(source);
  if (!result.ok || !result.ir) {
    throw new Error(`Compilation failed: ${result.diagnostics.map((d) => d.message).join(", ")}`);
  }
  return result.ir;
}

export function createTestInterpreter(options?: {
  agentResponses?: Record<string, unknown | StubAgentResponse>;
  programResponses?: Record<string, MockProgramResponse>;
  interpreterOptions?: InterpreterOptions;
  /** Use the real ProgramExecutor instead of the mock (for subprocess/timeout tests). */
  useRealProgramExecutor?: boolean;
  /** Inject the real acpx-backed AgentExecutor for builtin/command agents (e2e). */
  useRealAgentExecutor?: boolean;
}): { interpreter: WorkflowInterpreter; store: RunStore; tmpDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "acpus-interp-"));
  const store = new RunStore(tmpDir);

  const agentExecutor = options?.useRealAgentExecutor
    ? new AgentExecutor()
    : new StubAgentExecutor(
        Object.fromEntries(
          Object.entries(options?.agentResponses ?? {}).map(([k, v]) => [k, normalizeAgentResponse(v)])
        )
      );
  const programExecutor = options?.useRealProgramExecutor
    ? new ProgramExecutor()
    : new MockProgramExecutor(
        Object.fromEntries(
          Object.entries(options?.programResponses ?? {}).map(([k, v]) => [k, { ...v, delay: v.delay ?? 5 }])
        )
      );

  const interpreter = new WorkflowInterpreter(store, agentExecutor, programExecutor, {
    nowTimestamp: "2025-01-01T00:00:00Z",
    sleep: () => Promise.resolve(),
    ...options?.interpreterOptions
  });

  return {
    interpreter,
    store,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true })
  };
}

/** A plain object is treated as a successful agent output; a StubAgentResponse passes through. */
function normalizeAgentResponse(v: unknown): StubAgentResponse {
  if (v !== null && typeof v === "object" && ("output" in v || "sequence" in v || "failureKind" in v)) {
    return v as StubAgentResponse;
  }
  return { output: v, delay: 5 };
}

/**
 * Poll until a node reaches the expected state, with a timeout.
 * Replaces fragile setTimeout + if-checks with a robust polling loop.
 */
export async function waitForNodeState(
  store: RunStore, runId: string, nodeId: string, state: NodeState, timeoutMs: number
): Promise<NodeExecutionState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const nodes = store.listNodeStates(runId);
    const found = nodes.find((n) => n.nodeId === nodeId && n.state === state);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Node ${nodeId} did not reach state ${state} within ${timeoutMs}ms`);
}
