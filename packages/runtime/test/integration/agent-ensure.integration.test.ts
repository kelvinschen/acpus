import { describe, it, expect, afterEach } from "vitest";
import { AgentExecutor } from "../../src/executors/agent.js";
import type { IrNode } from "@acpus/core";
import type { ExpressionContext } from "../../src/types.js";
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, chmodSync, rmSync, readFileSync } from "node:fs";
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

function writeRecordingAcpxScript(dir: string): { script: string; logPath: string } {
  const script = join(dir, "mock-acpx-record.js");
  const logPath = join(dir, "argv.log");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("ensure")) {
  if (process.argv.includes("--format") && process.argv.includes("json")) {
    console.log(JSON.stringify({ action: "session_ensured", created: true, acpxRecordId: "mock-session-id" }));
  }
  process.exit(0);
}
console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
`);
  chmodSync(script, 0o755);
  return { script, logPath };
}

function writeEnvRecordingAcpxScript(dir: string): { script: string; envPath: string } {
  const script = join(dir, "mock-acpx-env.js");
  const envPath = join(dir, "env.log");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("ensure")) {
  if (process.argv.includes("--format") && process.argv.includes("json")) {
    console.log(JSON.stringify({ action: "session_ensured", created: true, acpxRecordId: "mock-session-id" }));
  }
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  inherited: process.env.ACPUS_AGENT_INHERITED_ENV ?? null,
  override: process.env.ACPUS_AGENT_OVERRIDE_ENV ?? null,
  bool: process.env.ACPUS_AGENT_BOOL_ENV ?? null
}));
console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
`);
  chmodSync(script, 0o755);
  return { script, envPath };
}

function writeSlowEnsureRecordingAcpxScript(dir: string): { script: string; logPath: string } {
  const script = join(dir, "mock-acpx-slow-ensure.js");
  const logPath = join(dir, "argv.log");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("ensure")) {
  if (process.argv.includes("--format") && process.argv.includes("json")) {
    process.stdout.write(JSON.stringify({ action: "session_ensured", created: true, acpxRecordId: "mock-session-id" }));
  }
  setTimeout(() => process.exit(0), 50);
} else {
  console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
  console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
}
`);
  chmodSync(script, 0o755);
  return { script, logPath };
}

function readRecordedPromptArgs(logPath: string): string[] {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  const calls = lines.map((line) => JSON.parse(line) as string[]);
  const promptArgs = calls.find((args) => args.includes("prompt"));
  if (!promptArgs) throw new Error("No prompt invocation was recorded");
  return promptArgs;
}

function readRecordedCalls(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as string[]);
}

function sessionFromPromptArgs(args: string[]): string {
  const index = args.indexOf("-s");
  if (index < 0) throw new Error("No -s argument was recorded");
  return args[index + 1]!;
}

function sessionFromEnsureArgs(args: string[]): string {
  const index = args.indexOf("--name");
  if (index < 0) throw new Error("No --name argument was recorded");
  return args[index + 1]!;
}

async function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
# Ensure with --format json
if [[ " $* " == *" ensure "* ]] && [[ " $* " == *" --format "* ]]; then
  echo '{"action":"session_ensured","created":true,"acpxRecordId":"mock-session-id"}'
  exit 0
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

describe("AgentExecutor: session_key", () => {
  it("uses the node-key-derived session name when session_key is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello"
    });
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent/round:0"
    });

    const calls = readRecordedCalls(logPath);
    const ensureArgs = calls.find((args) => args.includes("sessions") && args.includes("ensure"));
    const promptArgs = calls.find((args) => args.includes("prompt"));
    expect(ensureArgs).toBeDefined();
    expect(promptArgs).toBeDefined();
    expect(sessionFromEnsureArgs(ensureArgs!)).toBe("acpus-run-001-workflow__test-agent__round-0");
    expect(sessionFromPromptArgs(promptArgs!)).toBe("acpus-run-001-workflow__test-agent__round-0");
    expect(result.acpxRecordId).toBe("mock-session-id");
    expect(result.cwd).toBeTruthy();
  });

  it("uses a fixed session_key across different node keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      session_key: "fix-loop"
    });
    const signal = new AbortController().signal;
    await executor.execute({ node, context: baseCtx(), signal, nodeKey: "workflow/test-agent/round:0" });
    await executor.execute({ node, context: baseCtx(), signal, nodeKey: "workflow/test-agent/round:1" });

    const promptSessions = readRecordedCalls(logPath)
      .filter((args) => args.includes("prompt"))
      .map(sessionFromPromptArgs);
    expect(promptSessions).toEqual(["acpus-run-001-key-Zml4LWxvb3A", "acpus-run-001-key-Zml4LWxvb3A"]);
  });

  it("evaluates templated session_key from execution context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      session_key: "${{ input.ticket }}-${{ item_id }}-${{ loop.iter }}-${{ steps.seed.exit_code }}"
    });
    const ctx: ExpressionContext = {
      input: { ticket: "T-7" },
      steps: { seed: { exit_code: 0 } },
      loop: { iter: 2 },
      item_id: "file:alpha",
      run_id: "run-001"
    };
    await executor.execute({
      node,
      context: ctx,
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent/round:2"
    });

    const promptArgs = readRecordedPromptArgs(logPath);
    expect(sessionFromPromptArgs(promptArgs)).toBe("acpus-run-001-key-VC03LWZpbGU6YWxwaGEtMi0w");
  });

  it("encodes author-controlled session_key values without sanitizer aliases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const signal = new AbortController().signal;
    for (const key of ["a/b", "a__b", "a:b", "a-b"]) {
      const node = makeAgentNode({
        agent: { type: "builtin", use: "mock", model: "test-model" },
        prompt: "Hello",
        session_key: key
      });
      await executor.execute({ node, context: baseCtx(), signal, nodeKey: `workflow/${key}` });
    }

    const sessions = readRecordedCalls(logPath)
      .filter((args) => args.includes("prompt"))
      .map(sessionFromPromptArgs);
    expect(new Set(sessions).size).toBe(4);
  });

  it("returns config failure when session_key template evaluation fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      session_key: "${{ missing.value }}"
    });
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.failureKind).toBe("config");
    expect(result.error).toContain("Failed to evaluate agent configuration template");
    expect(readRecordedCalls(logPath)).toEqual([]);
  });

  it("returns config failure when session_key renders blank", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      session_key: "   "
    });
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.failureKind).toBe("config");
    expect(result.error).toContain("session_key must render to a non-empty string");
    expect(readRecordedCalls(logPath)).toEqual([]);
  });

  it("does not close a session when aborted after ensure but before prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeSlowEnsureRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      session_key: "shared"
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: controller.signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.partial).toBe(true);
    const calls = readRecordedCalls(logPath);
    expect(calls.some((args) => args.includes("sessions") && args.includes("ensure"))).toBe(true);
    expect(calls.some((args) => args.includes("sessions") && args.includes("close"))).toBe(false);
    expect(calls.some((args) => args.includes("prompt"))).toBe(false);
  });
});

describe("AgentExecutor: cwd resolution", () => {
  it("passes agent.cwd to acpx and returns it on the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model", cwd: "/custom/workspace" },
      prompt: "Hello"
    });
    const result = await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.cwd).toBe("/custom/workspace");
    const promptArgs = readRecordedPromptArgs(logPath);
    const cwdIndex = promptArgs.indexOf("--cwd");
    expect(cwdIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs[cwdIndex + 1]).toBe("/custom/workspace");
  });

  it("defaults cwd to process.cwd() when agent cwd is not set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script } = writeRecordingAcpxScript(dir);

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

    expect(result.cwd).toBe(process.cwd());
  });

  it("lets a step-level cwd override the agent definition cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model", cwd: "/agent/default" },
      cwd: "${{ input.target }}",
      prompt: "Hello"
    });
    const result = await executor.execute({
      node,
      context: { input: { target: "/step/override" }, steps: {}, run_id: "run-001" },
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    expect(result.cwd).toBe("/step/override");
    const promptArgs = readRecordedPromptArgs(logPath);
    const cwdIndex = promptArgs.indexOf("--cwd");
    expect(promptArgs[cwdIndex + 1]).toBe("/step/override");
  });
});

describe("AgentExecutor: acpx timeout", () => {
  it("passes string Agent Step timeout to acpx as seconds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      timeout: "20m"
    });
    await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    const promptArgs = readRecordedPromptArgs(logPath);
    const timeoutIndex = promptArgs.indexOf("--timeout");
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs[timeoutIndex + 1]).toBe("1200");
  });

  it("passes numeric Agent Step timeout to acpx as seconds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello",
      timeout: 300
    });
    await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    const promptArgs = readRecordedPromptArgs(logPath);
    const timeoutIndex = promptArgs.indexOf("--timeout");
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs[timeoutIndex + 1]).toBe("0.3");
  });

  it("omits acpx timeout when Agent Step timeout is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
    tmpDirs.push(dir);
    const { script, logPath } = writeRecordingAcpxScript(dir);

    const executor = new AgentExecutor({ acpxPath: script });
    const node = makeAgentNode({
      agent: { type: "builtin", use: "mock", model: "test-model" },
      prompt: "Hello"
    });
    await executor.execute({
      node,
      context: baseCtx(),
      signal: new AbortController().signal,
      nodeKey: "workflow/test-agent"
    });

    const promptArgs = readRecordedPromptArgs(logPath);
    expect(promptArgs).not.toContain("--timeout");
  });

  it("passes inherited process env plus stringified agent env overrides to acpx", async () => {
    await withEnv({
      ACPUS_AGENT_INHERITED_ENV: "visible-to-agent",
      ACPUS_AGENT_OVERRIDE_ENV: "inherited-value"
    }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "acpus-agent-test-"));
      tmpDirs.push(dir);
      const { script, envPath } = writeEnvRecordingAcpxScript(dir);

      const executor = new AgentExecutor({ acpxPath: script });
      const node = makeAgentNode({
        agent: {
          type: "builtin",
          use: "mock",
          model: "test-model",
          env: {
            ACPUS_AGENT_OVERRIDE_ENV: "${{ input.override }}",
            ACPUS_AGENT_BOOL_ENV: false
          }
        },
        prompt: "Hello"
      });
      const ctx: ExpressionContext = { input: { override: "agent-step-value" }, steps: {}, run_id: "run-001" };
      await executor.execute({
        node,
        context: ctx,
        signal: new AbortController().signal,
        nodeKey: "workflow/test-agent"
      });

      expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual({
        inherited: "visible-to-agent",
        override: "agent-step-value",
        bool: "false"
      });
    });
  });
});
