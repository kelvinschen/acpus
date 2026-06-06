import { compileWorkflow } from "@acpus/core";
import type { AcpusIr } from "@acpus/core";
import { RunStore } from "../../src/store.js";
import { WorkflowInterpreter } from "../../src/interpreter.js";
import { MockAgentExecutor } from "../../src/executors/mock-agent.js";
import { MockProgramExecutor } from "../../src/executors/mock-program.js";
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
  agentResponses?: Record<string, unknown>;
  programResponses?: Record<string, { stdout?: string; exitCode?: number; parsedOutput?: unknown }>;
  interpreterOptions?: InterpreterOptions;
}): { interpreter: WorkflowInterpreter; store: RunStore; tmpDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "acpus-interp-"));
  const store = new RunStore(tmpDir);

  const agentExecutor = new MockAgentExecutor(
    Object.fromEntries(
      Object.entries(options?.agentResponses ?? {}).map(([k, v]) => [k, { output: v, delay: 5 }])
    )
  );
  const programExecutor = new MockProgramExecutor(
    Object.fromEntries(
      Object.entries(options?.programResponses ?? {}).map(([k, v]) => [k, { ...v, delay: 5 }])
    )
  );

  const interpreter = new WorkflowInterpreter(store, agentExecutor, programExecutor, {
    nowTimestamp: "2025-01-01T00:00:00Z",
    ...options?.interpreterOptions
  });

  return {
    interpreter,
    store,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true })
  };
}
