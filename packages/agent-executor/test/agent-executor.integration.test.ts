import { describe, expect, it } from "vitest";
import { executeAgentRequest } from "@acpus/agent-executor";

describe("agent executor command integration", () => {
  it("retries when accepted output rejects an attempt", async () => {
    const output = await executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'if (process.env.ACPUS_AGENT_ATTEMPT === \"1\") process.stdout.write(JSON.stringify({ attempt: 1 })); else process.stdout.write(JSON.stringify({ attempt: process.env.ACPUS_AGENT_ATTEMPT }))'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 2,
      acceptOutput(value) {
        if (!value || typeof value !== "object" || typeof (value as { attempt?: unknown }).attempt !== "string") {
          throw new Error("attempt must be a string");
        }
        return value;
      },
    });

    expect(output).toEqual({ attempt: "2" });
  });

  it("reports timeout at the package boundary", async () => {
    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 100)'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
      timeout: "5ms",
    })).rejects.toThrow("Agent node 'review' timed out after 5ms.");
  });

  it("aborts command-backed agent attempts when the outer attempt is cancelled", async () => {
    const controller = new AbortController();
    const execution = executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 1000)'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
      signal: controller.signal,
    });
    controller.abort();

    await expect(execution).rejects.toThrow("Agent node 'review' was aborted.");
  });

  it("rejects pre-aborted command-backed agent attempts before spawning", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'process.stdout.write(JSON.stringify({ ok: true }))'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
      signal: controller.signal,
    })).rejects.toThrow("Agent node 'review' was aborted.");
  });

  it("reports non-zero exits at the package boundary", async () => {
    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'process.stderr.write(\"bad\"); process.exit(7)'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
    })).rejects.toThrow("Agent command exited with 7: bad");
  });

  it("reports output overflow at the package boundary", async () => {
    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'process.stdout.write(\"x\".repeat(1000001))'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
    })).rejects.toThrow("Agent command output exceeded 1000000 bytes.");
  });

  it("terminates stubborn timed-out command process trees", async () => {
    const marker = ".tmp-tests/stubborn-agent-child.txt";
    const { mkdir, readFile, rm } = await import("node:fs/promises");
    await mkdir(".tmp-tests", { recursive: true });
    await rm(marker, { force: true });

    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'const { spawn } = require(\"node:child_process\"); spawn(process.execPath, [\"-e\", \"process.on(\\\\\"SIGTERM\\\\\", () => {}); setTimeout(() => require(\\\\\"node:fs\\\\\").writeFileSync(\\\\\".tmp-tests/stubborn-agent-child.txt\\\\\", \\\\\"alive\\\\\"), 80); setTimeout(() => {}, 1000);\"], { detached: false, stdio: \"ignore\" }); process.on(\"SIGTERM\", () => {}); setTimeout(() => {}, 1000);'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
      timeout: "5ms",
    })).rejects.toThrow("Agent node 'review' timed out after 5ms.");

    await new Promise(resolve => setTimeout(resolve, 150));
    const markerText = await readFile(marker, "utf8").catch(() => "");
    expect(markerText).not.toContain("alive");
    await rm(marker, { force: true });
  });

  it("clamps maxAttempts to one attempt", async () => {
    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'process.stdout.write(JSON.stringify({ ok: true }))'",
      prompt: "review",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 0,
    })).resolves.toEqual({ ok: true });
  });

  it("passes the resolved prompt through the agent environment", async () => {
    await expect(executeAgentRequest({
      kind: "command",
      nodeId: "review",
      command: "node -e 'process.stdout.write(JSON.stringify({ prompt: process.env.ACPUS_AGENT_PROMPT }))'",
      prompt: "resolved prompt",
      cwd: process.cwd(),
      env: process.env,
      maxAttempts: 1,
    })).resolves.toEqual({ prompt: "resolved prompt" });
  });
});
