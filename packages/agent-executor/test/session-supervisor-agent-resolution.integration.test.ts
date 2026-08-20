import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { ok } from "neverthrow";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Session Supervisor Agent resolution", () => {
  it("returns an unbound typed resolution failure before callback execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-supervisor-resolution-"));
    roots.push(root);
    const created = await createAgentSessionSupervisor({
      workersRoot: join(root, "workers"),
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { epoch: 1, pid: process.pid },
      namedAgentLaunches: {},
    });
    if (created.isErr()) throw new Error(created.error.message);
    let called = false;
    const result = await created.value.withSessionLease({
      attempt: { runId: "run", nodeKey: "node", attemptId: "attempt", ownerEpoch: 1, signal: new AbortController().signal },
      session: {
        agentSessionId: "session",
        sessionOpenMode: "new_or_empty",
        agent: { kind: "named", name: "missing" },
        cwd: root,
        env: {},
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
    expect((await created.value.shutdown()).isOk()).toBe(true);
  });
});
