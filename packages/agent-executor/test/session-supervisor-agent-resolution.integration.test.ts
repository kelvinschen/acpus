import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { makeNodeProcessHost } from "@acpus/owned-process";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { settle } from "./effect.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Session Supervisor Agent resolution", () => {
  scopedTest("returns an unbound typed resolution failure before callback execution", async scope => {
    const root = await mkdtemp(join(tmpdir(), "acpus-supervisor-resolution-"));
    roots.push(root);
    const configuredAgentCommand = vi.fn(() => Effect.fail({
      type: "agent-config" as const,
      message: "unified config is invalid",
    }));
    const created = await settle(Scope.provide(scope)(createAgentSessionSupervisor({
      workersRoot: join(root, "workers"),
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { epoch: 1, pid: process.pid },
      namedAgentLaunches: {},
      configuredAgentCommand,
    }, makeNodeProcessHost())));
    if (Result.isFailure(created)) throw new Error(created.failure.message);
    let called = false;
    const result = await settle(created.success.withSessionLease({
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
      return lease.runTurn({ turnId: "turn", prompt: "unused", onEvent: () => Result.succeed(undefined) });
    }));
    expect(called).toBe(false);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      type: "acquire",
      error: { type: "agent_resolution_failed" },
    });
    expect(configuredAgentCommand).toHaveBeenCalledWith(["factorydroid", "droid"]);
    expect(Result.isSuccess(await settle(created.success.shutdown()))).toBe(true);
  });
});

function scopedTest(name: string, test: (scope: Scope.Scope) => Promise<void>): void {
  it.effect(name, () => Effect.gen(function*() {
    const scope = yield* Effect.scope;
    yield* Effect.promise(() => test(scope));
  }));
}
