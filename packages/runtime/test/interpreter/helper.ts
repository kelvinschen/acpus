import { compileWorkflow } from "@acpus/core";
import type { AcpusIr } from "@acpus/core";
import { RunStore } from "../../src/store.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { MockAgentExecutor } from "../../src/executors/mock-agent.js";
import type { MockAgentResponse } from "../../src/executors/mock-agent.js";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
import type { MockProgramResponse } from "../../src/executors/mock-program.js";
import { ProgramExecutor } from "../../src/executors/program.js";
import type { InterpreterOptions } from "../../src/types.js";
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
  agentResponses?: Record<string, unknown | MockAgentResponse>;
  programResponses?: Record<string, MockProgramResponse>;
  interpreterOptions?: InterpreterOptions;
  /** Use the real ProgramExecutor instead of the mock (for subprocess/timeout tests). */
  useRealProgramExecutor?: boolean;
}): { interpreter: WorkflowInterpreter; store: RunStore; tmpDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "acpus-interp-"));
  const store = new RunStore(tmpDir);

  const agentExecutor = new MockAgentExecutor(
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

/** A plain object is treated as a successful agent output; a MockAgentResponse passes through. */
function normalizeAgentResponse(v: unknown): MockAgentResponse {
  if (v !== null && typeof v === "object" && ("output" in v || "sequence" in v || "failureKind" in v)) {
    return v as MockAgentResponse;
  }
  return { output: v, delay: 5 };
}
