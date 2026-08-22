import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { makeNodeProcessHost } from "@acpus/owned-process";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { settle } from "./effect.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Agent Session Supervisor", () => {
  scopedTest("commits empty neutralization exactly once", async scope => {
    const supervisor = await testSupervisor(scope);
    let commits = 0;
    const result = await settle(supervisor.withSessionsNeutralized(
      { sessions: [], signal: new AbortController().signal },
      evidence => {
        commits += 1;
        expect(evidence).toEqual([]);
        return Result.succeed("committed");
      },
    ));
    expect(Result.isSuccess(result) && result.success).toBe("committed");
    expect(commits).toBe(1);
    expect(Result.isSuccess(await settle(supervisor.shutdown()))).toBe(true);
  });

  scopedTest("closes admission and shares concurrent shutdown settlement", async scope => {
    const supervisor = await testSupervisor(scope);
    const [first, second] = await Promise.all([
      settle(supervisor.shutdown()),
      settle(supervisor.shutdown()),
    ]);
    expect(Result.isSuccess(first)).toBe(true);
    expect(Result.isSuccess(second)).toBe(true);
    const acquired = await settle(supervisor.withSessionLease(leaseInput("closed"), lease => lease.runTurn({
      turnId: "turn",
      prompt: "unused",
      onEvent: () => Result.succeed(undefined),
    })));
    expect(Result.isFailure(acquired) && acquired.failure).toMatchObject({
      type: "acquire",
      error: { type: "supervisor_closed" },
    });
  });

  scopedTest("runs semantic shutdown when the owning Scope closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-session-supervisor-scope-"));
    roots.push(root);
    const scope = Scope.makeUnsafe();
    const created = await (async () => {
      try {
        return await settle(Scope.provide(scope)(createAgentSessionSupervisor({
          workersRoot: join(root, "workers"),
          sessionStateDirectoryForRun: runId => join(root, "runs", runId),
          owner: { epoch: 1, pid: process.pid },
        }, makeNodeProcessHost())));
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    })();
    if (Result.isFailure(created)) throw new Error(created.failure.message);

    const acquired = await settle(created.success.withSessionLease(
      leaseInput("scope-closed"),
      lease => lease.runTurn({
        turnId: "turn",
        prompt: "unused",
        onEvent: () => Result.succeed(undefined),
      }),
    ));
    expect(Result.isFailure(acquired) && acquired.failure).toMatchObject({
      type: "acquire",
      error: { type: "supervisor_closed" },
    });
    expect(Result.isSuccess(await settle(created.success.shutdown()))).toBe(true);
  });
});

async function testSupervisor(scope: Scope.Scope) {
  const root = await mkdtemp(join(tmpdir(), "acpus-session-supervisor-"));
  roots.push(root);
  const created = await settle(Scope.provide(scope)(createAgentSessionSupervisor({
    workersRoot: join(root, "workers"),
    sessionStateDirectoryForRun: runId => join(root, "runs", runId),
    owner: { epoch: 1, pid: process.pid },
  }, makeNodeProcessHost())));
  if (Result.isFailure(created)) throw new Error(created.failure.message);
  return created.success;
}

function scopedTest(name: string, test: (scope: Scope.Scope) => Promise<void>): void {
  it.effect(name, () => Effect.gen(function*() {
    const scope = yield* Effect.scope;
    yield* Effect.promise(() => test(scope));
  }));
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
