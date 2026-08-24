import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { makeNodeProcessHost } from "@acpus/owned-process";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { settle } from "./effect.js";

const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));

describe.concurrent("Process Capsule", () => {
  liveTest("durably owns one cold capsule, runs a Turn, and proves cleanup", async scope => {
    const { root, supervisor } = await setup(scope);
    const result = await settle(supervisor.withSessionLease(input(root, "complete"), lease => {
      expect(lease.reportedVersion).toBe("1.0.0");
      return lease.runTurn({
        turnId: "turn-complete",
        prompt: "work",
        onEvent: () => Result.succeed(undefined),
      });
    }));
    expect(Result.isSuccess(result) && result.success).toMatchObject({ finalResponse: "unit-response" });
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect(Result.isSuccess(await settle(supervisor.shutdown()))).toBe(true);
  });

  liveTestTimeout("rejects a second acquire for the same Session before spawning", 10_000, async scope => {
    const { root, supervisor } = await setup(scope);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = settle(supervisor.withSessionLease(input(root, "busy"), () => Effect.promise(async () => {
      entered();
      await held;
      return "first";
    })));
    await ready;
    const second = await settle(supervisor.withSessionLease(input(root, "busy", "attempt-second"), lease => lease.runTurn({
      turnId: "turn-second",
      prompt: "unused",
      onEvent: () => Result.succeed(undefined),
    })));
    expect(Result.isFailure(second) && second.failure).toMatchObject({ type: "acquire", error: { type: "session_busy" } });
    release();
    expect(Result.isSuccess(await first)).toBe(true);
    expect(Result.isSuccess(await settle(supervisor.shutdown()))).toBe(true);
  });

  liveTest("returns typed open failure without invoking the callback", async scope => {
    const { root, supervisor } = await setup(scope);
    let called = false;
    const result = await settle(supervisor.withSessionLease(input(root, "open-failure", undefined, ["exit-on-initialize"]), lease => {
      called = true;
      return lease.runTurn({ turnId: "unused", prompt: "unused", onEvent: () => Result.succeed(undefined) });
    }));
    expect(called).toBe(false);
    expect(Result.isFailure(result) && result.failure).toMatchObject({ type: "acquire" });
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect(Result.isSuccess(await settle(supervisor.shutdown()))).toBe(true);
  });

  liveTestTimeout("allows Provider readiness to exceed the bootstrap orphan watchdog", 15_000, async scope => {
    const { root, supervisor } = await setup(scope);
    const gateDirectory = join(root, "slow-ready-gate");
    vi.useFakeTimers();
    try {
      const result = settle(supervisor.withSessionLease(input(root, "slow-ready", undefined, ["gate-initialize"], {
        ACP_FIXTURE_GATE_DIRECTORY: gateDirectory,
      }), lease => lease.runTurn({
        turnId: "turn-slow-ready",
        prompt: "work",
        onEvent: () => Result.succeed(undefined),
      })));
      await waitForPath(join(gateDirectory, "initialize.started"));
      await vi.advanceTimersByTimeAsync(5_100);
      vi.useRealTimers();
      await writeFile(join(gateDirectory, "initialize.release"), "");

      expect(Result.isSuccess(await result)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect(Result.isSuccess(await settle(supervisor.shutdown()))).toBe(true);
  });
});

async function setup(scope: Scope.Scope) {
  const root = await mkdtemp(join(tmpdir(), "acpus-process-capsule-"));
  await settle(Scope.addFinalizer(scope, Effect.promise(() => rm(root, { recursive: true, force: true }))));
  const created = await settle(Scope.provide(scope)(createAgentSessionSupervisor({
    workersRoot: join(root, "workers"),
    sessionStateDirectoryForRun: runId => join(root, "runs", runId),
    owner: { epoch: 1, pid: process.pid },
  }, makeNodeProcessHost())));
  if (Result.isFailure(created)) throw new Error(created.failure.message);
  return { root, supervisor: created.success };
}

function liveTest(name: string, test: (scope: Scope.Scope) => Promise<void>): void {
  it.live(name, () => Effect.gen(function*() {
    const scope = yield* Effect.scope;
    yield* Effect.promise(() => test(scope));
  }));
}

function liveTestTimeout(name: string, timeout: number, test: (scope: Scope.Scope) => Promise<void>): void {
  it.live(name, () => Effect.gen(function*() {
    const scope = yield* Effect.scope;
    yield* Effect.promise(() => test(scope));
  }), { timeout });
}

function input(
  root: string,
  id: string,
  attemptId = `attempt-${id}`,
  flags: readonly string[] = [],
  env: Readonly<NodeJS.ProcessEnv> = {},
) {
  return {
    attempt: { runId: "run", nodeKey: "node", attemptId, ownerEpoch: 1, signal: new AbortController().signal },
    session: {
      agentSessionId: `session-${id}`,
      sessionOpenMode: "new_or_empty" as const,
      agent: {
        kind: "command" as const,
        command: [process.execPath, fixtureAgent, "unit-response", ...flags].map(value => JSON.stringify(value)).join(" "),
      },
      cwd: root,
      env,
      permissionMode: "deny-all" as const,
      configuration: { options: {} },
    },
  };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await wait(5);
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function directoryEntries(path: string): Promise<string[]> {
  try {
    await access(path);
    return await readdir(path);
  } catch {
    return [];
  }
}
