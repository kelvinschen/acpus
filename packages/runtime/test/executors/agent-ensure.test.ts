import { describe, it, expect, afterEach } from "vitest";
import { AgentExecutor } from "../../src/executors/agent.js";
import type { IrNode } from "@acpus/core";
import type { ExpressionContext } from "../../src/types.js";
import { mkdtempSync, writeFileSync, unlinkSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeAgentNode(metadata: Record<string, unknown>): IrNode {
  return {
    id: "test-agent",
    kind: "run.agent",
    nodePath: ["workflow", "test-agent"],
    keyTemplate: { astVersion: 1, nodePath: "workflow/test-agent" },
    metadata
  };
}

function baseCtx(): ExpressionContext {
  return { input: {}, steps: {}, run_id: "run-001" };
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

/**
 * Write a mock acpx script that fails `sessions ensure` with a specific exit
 * code and stderr message, then succeeds on other subcommands.
 */
function writeFailingEnsureScript(dir: string, exitCode: number, stderr: string): string {
  const script = join(dir, "mock-acpx.sh");
  // The script inspects the arguments: if "sessions" and "ensure" are present,
  // it exits with the configured code and stderr. Otherwise it exits 0.
  writeFileSync(script, `#!/bin/bash
if [[ " $* " == *" sessions ensure "* ]]; then
  echo "${stderr}" >&2
  exit ${exitCode}
fi
# Other subcommands succeed with empty NDJSON
echo '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
exit 0
`);
  chmodSync(script, 0o755);
  return script;
}

describe("AgentExecutor: sessions ensure failure", () => {
  it("returns spawn failure when acpx sessions ensure exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const acpxPath = writeFailingEnsureScript(dir, 3, "NO_SESSION: failed to create session");

    const executor = new AgentExecutor({ acpxPath });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello"
    });
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.failureKind).toBe("spawn");
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain("NO_SESSION");
    expect(result.stderr).toContain("NO_SESSION");
  });

  it("falls back to shortMessage when stderr is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    // Write a script that exits non-zero with no stderr
    const script = join(dir, "mock-acpx-noerr.sh");
    writeFileSync(script, `#!/bin/bash
if [[ " $* " == *" sessions ensure "* ]]; then
  exit 42
fi
echo '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
exit 0
`);
    chmodSync(script, 0o755);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello"
    });
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.failureKind).toBe("spawn");
    expect(result.exitCode).toBe(42);
    expect(result.error).toBeTruthy();
  });
});
