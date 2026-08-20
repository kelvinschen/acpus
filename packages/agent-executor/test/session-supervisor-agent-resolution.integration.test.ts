import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { errAsync, ok } from "neverthrow";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Session Supervisor Agent resolution", () => {
  it("returns an unbound typed resolution failure before callback execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-supervisor-resolution-"));
    roots.push(root);
    const configuredAgentCommand = vi.fn(() => errAsync({
      type: "agent-config" as const,
      message: "unified config is invalid",
    }));
    const created = await createAgentSessionSupervisor({
      workersRoot: join(root, "workers"),
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { epoch: 1, pid: process.pid },
      namedAgentLaunches: {},
      configuredAgentCommand,
    });
    if (created.isErr()) throw new Error(created.error.message);
    let called = false;
    const result = await created.value.withSessionLease({
      attempt: { runId: "run", nodeKey: "node", attemptId: "attempt", ownerEpoch: 1, signal: new AbortController().signal },
      session: {
        agentSessionId: "session",
        sessionOpenMode: "new_or_empty",
        agent: { kind: "named", name: "factorydroid" },
        cwd: join(root, "agent-cwd-must-not-select-config"),
        env: { HOME: join(root, "workflow-home-must-not-select-config") },
        permissionMode: "deny-all",
        configuration: { options: {} },
      },
    }, lease => {
      called = true;
      return lease.runTurn({ turnId: "turn", prompt: "unused", onEvent: () => ok(undefined) });
    });
    expect(called).toBe(false);
    expect(result.isErr() && result.error).toMatchObject({
      type: "acquire",
      error: { type: "agent_resolution_failed" },
    });
    expect(configuredAgentCommand).toHaveBeenCalledWith(["factorydroid", "droid"]);
    expect((await created.value.shutdown()).isOk()).toBe(true);
  });
});
