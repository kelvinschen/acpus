import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAgentTurn } from "@acpus/agent-executor";

describe("agent executor acpx process integration", () => {
  it("passes millisecond runtime timeout budgets to acpx as positive seconds", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    try {
      const result = await executeAgentTurn({
        agent: { kind: "command", command: `${process.execPath} -e "process.exit(1)"` },
        prompt: "review",
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          XDG_CACHE_HOME: join(cwd, ".cache"),
          XDG_CONFIG_HOME: join(cwd, ".config"),
          TMPDIR: cwd,
        },
        sessionName: "acpus-agent-executor-timeout",
        permissionMode: "approve-all",
        timeout: "1500ms",
      });

      expect(result).toMatchObject({
        status: "failed",
        failureKind: "provider_exit",
      });
      expect(result.status === "failed" ? result.message : "").not.toContain("Timeout must be a positive number of seconds");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
