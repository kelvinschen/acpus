import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { ok } from "neverthrow";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Agent Session Supervisor", () => {
  it("commits empty neutralization exactly once", async () => {
    const supervisor = await testSupervisor();
    let commits = 0;
    const result = await supervisor.withSessionsNeutralized(
      { sessions: [], signal: new AbortController().signal },
      evidence => {
        commits += 1;
        expect(evidence).toEqual([]);
        return ok("committed");
      },
    );
    expect(result.isOk() && result.value).toBe("committed");
    expect(commits).toBe(1);
    expect((await supervisor.shutdown()).isOk()).toBe(true);
  });

  it("closes admission and shares concurrent shutdown settlement", async () => {
    const supervisor = await testSupervisor();
    const [first, second] = await Promise.all([supervisor.shutdown(), supervisor.shutdown()]);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const acquired = await supervisor.withSessionLease(leaseInput("closed"), lease => lease.runTurn({
      turnId: "turn",
      prompt: "unused",
      onEvent: () => ok(undefined),
    }));
    expect(acquired.isErr() && acquired.error).toMatchObject({
      type: "acquire",
      error: { type: "supervisor_closed" },
    });
  });
});

async function testSupervisor() {
  const root = await mkdtemp(join(tmpdir(), "acpus-session-supervisor-"));
  roots.push(root);
  const created = await createAgentSessionSupervisor({
    workersRoot: join(root, "workers"),
    sessionStateDirectoryForRun: runId => join(root, "runs", runId),
    owner: { epoch: 1, pid: process.pid },
  });
  if (created.isErr()) throw new Error(created.error.message);
  return created.value;
}

function leaseInput(id: string) {
  return {
    attempt: {
      runId: "run",
      nodeKey: "node",
      attemptId: `attempt-${id}`,
      ownerEpoch: 1,
      signal: new AbortController().signal,
    },
    session: {
      agentSessionId: `session-${id}`,
      sessionOpenMode: "new_or_empty" as const,
      agent: { kind: "command" as const, command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}` },
      cwd: process.cwd(),
      env: {},
      permissionMode: "deny-all" as const,
      configuration: { options: {} },
    },
  };
}
