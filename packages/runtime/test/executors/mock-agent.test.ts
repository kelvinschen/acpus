import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockAgentExecutor } from "../../src/executors/mock-agent.js";
import type { IrNode } from "@acpus/core";
import type { ExpressionContext } from "../../src/types.js";

function makeAgentNode(metadata: Record<string, unknown>): IrNode {
  return {
    id: "test-step",
    kind: "run.agent",
    nodePath: ["workflow", "test-step"],
    keyTemplate: { astVersion: 1, nodePath: "workflow/test-step" },
    metadata
  };
}

function baseCtx(): ExpressionContext {
  return { input: {}, steps: {}, run_id: "test" };
}

describe("MockAgentExecutor", () => {
  it("returns mock output for configured step", async () => {
    const executor = new MockAgentExecutor({
      "test-step": { output: { result: "done" } }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.output).toEqual({ result: "done" });
    expect(result.error).toBeUndefined();
  });

  it("returns error for unconfigured step", async () => {
    const executor = new MockAgentExecutor({});
    const node = makeAgentNode({ prompt: "Do something" });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });

    expect(result.error).toContain("No mock response");
  });

  it("returns partial result on abort signal", async () => {
    const executor = new MockAgentExecutor({
      "test-step": { output: { partial: true }, delay: 1000 }
    });
    const node = makeAgentNode({ prompt: "Do something" });
    const controller = new AbortController();

    // Abort immediately
    controller.abort();

    const result = await executor.execute({ node, context: baseCtx(), signal: controller.signal, nodeKey: node.id });
    expect(result.partial).toBe(true);
  });

  it("selects a mock_script response by rendered prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-mock-script-"));
    try {
      const scriptPath = join(dir, "mock.yaml");
      writeFileSync(scriptPath, `
version: 1
agent_id: script-test
default_response:
  type: json
  payload:
    branch: default
rules:
  - name: scripted
    when:
      prompt_contains: "lane alpha"
    respond:
      type: json
      payload:
        branch: scripted
        ok: true
`, "utf8");
      const executor = new MockAgentExecutor({});
      const node = makeAgentNode({
        prompt: "Review lane ${{ input.lane }}",
        agent: { type: "mock", mock_script: scriptPath }
      });
      const result = await executor.execute({
        node,
        context: { ...baseCtx(), input: { lane: "alpha" } },
        signal: new AbortController().signal,
        nodeKey: node.id
      });
      expect(result.output).toEqual({ branch: "scripted", ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates output against schema", async () => {
    const executor = new MockAgentExecutor({
      "test-step": { output: { score: 8 } }
    });
    const node = makeAgentNode({
      prompt: "Score it",
      output: {
        type: "object",
        properties: {
          score: { type: "number" }
        },
        required: ["score"]
      }
    });
    const result = await executor.execute({ node, context: baseCtx(), signal: new AbortController().signal, nodeKey: node.id });
    expect(result.output).toEqual({ score: 8 });
  });
});
