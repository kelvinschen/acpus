import { describe, expect, it } from "vitest";
import type { AcpusIr } from "@acpus/core";
import { ExpressionEvaluator } from "../../src/evaluator.js";
import {
  buildCompletedStepContext,
  evaluateOutputObject,
  evaluateTemplatedValue,
  evaluateWorkflowOutputs,
  normalizeOutputValue
} from "../../src/workflow-outputs.js";
import type { NodeExecutionState } from "../../src/types.js";

const evaluator = new ExpressionEvaluator({ nowTimestamp: "2025-01-01T00:00:00Z" });

function irWithOutputs(outputs: Record<string, unknown>): AcpusIr {
  return {
    irVersion: 1,
    astVersion: 1,
    source: { digest: "sha256:test" },
    name: "output-test",
    input: {},
    agents: {},
    root: {
      id: "workflow",
      kind: "pipeline",
      nodePath: ["workflow"],
      keyTemplate: { astVersion: 1, nodePath: "workflow" },
      metadata: {}
    },
    outputs,
    expressions: []
  };
}

describe("workflow output evaluation", () => {
  it("preserves native values for single-expression outputs", () => {
    const output = evaluateWorkflowOutputs(
      irWithOutputs({ count: "${{ len(steps.items.output) }}", ready: "${{ steps.check.output.ready }}" }),
      {
        input: {},
        run_id: "run-1",
        steps: {
          items: { output: ["a", "b"] },
          check: { output: { ready: true } }
        }
      },
      evaluator
    );

    expect(output).toEqual({ count: 2, ready: true });
  });

  it("stringifies embedded template expressions", () => {
    const value = evaluateTemplatedValue("run=${{ run_id }} count=${{ len(steps.items.output) }}", {
      input: {},
      run_id: "run-1",
      steps: { items: { output: ["a", "b"] } }
    }, evaluator);

    expect(value).toBe("run=run-1 count=2");
  });

  it("evaluates output objects and arrays recursively", () => {
    const output = evaluateOutputObject({
      nested: {
        values: ["${{ steps.first.output.value }}", "literal"],
        ok: "${{ steps.first.output.ok }}"
      }
    }, {
      input: {},
      run_id: "run-1",
      steps: { first: { output: { value: "native", ok: true } } }
    }, evaluator);

    expect(output).toEqual({ nested: { values: ["native", "literal"], ok: true } });
  });

  it("includes the failing output key path in evaluation errors", () => {
    expect(() => evaluateOutputObject({
      nested: {
        missing: "${{ steps.first.output.value.missing }}"
      }
    }, {
      input: {},
      run_id: "run-1",
      steps: { first: { output: { value: "native" } } }
    }, evaluator)).toThrow(/Workflow output 'nested\.missing' failed to evaluate:/);
  });

  it("normalizes bigint values inside arrays and objects", () => {
    expect(normalizeOutputValue({ count: 2n, nested: [3n] })).toEqual({ count: 2, nested: [3] });
  });

  it("builds completed step context from the root pipeline envelope", () => {
    const nodes: NodeExecutionState[] = [
      {
        nodeKey: "workflow",
        nodeId: "workflow",
        kind: "pipeline",
        state: "completed",
        attempt: 1,
        output: {
          output: {
            first: { output: { value: "ok" } }
          }
        }
      }
    ];

    expect(buildCompletedStepContext({ file: "a.ts" }, "run-1", nodes)).toEqual({
      input: { file: "a.ts" },
      run_id: "run-1",
      steps: {
        first: { output: { value: "ok" } }
      }
    });
  });
});
