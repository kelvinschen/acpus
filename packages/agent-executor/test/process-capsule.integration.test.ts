import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionSupervisor } from "@acpus/agent-executor";
import { ok, ResultAsync } from "neverthrow";

const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Process Capsule", () => {
  it("durably owns one cold capsule, runs a Turn, and proves cleanup", async () => {
    const { root, supervisor } = await setup();
    const result = await supervisor.withSessionLease(input(root, "complete"), lease => {
      expect(lease.reportedVersion).toBe("1.0.0");
      return lease.runTurn({
        turnId: "turn-complete",
        prompt: "work",
        onEvent: () => ok(undefined),
      });
    });
    expect(result.isOk() && result.value).toMatchObject({ finalResponse: "unit-response" });
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect((await supervisor.shutdown()).isOk()).toBe(true);
  });

  it("rejects a second acquire for the same Session before spawning", { timeout: 10_000 }, async () => {
    const { root, supervisor } = await setup();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = supervisor.withSessionLease(input(root, "busy"), () => new ResultAsync((async () => {
      entered();
      await held;
      return ok("first");
    })()));
    await ready;
    const second = await supervisor.withSessionLease(input(root, "busy", "attempt-second"), lease => lease.runTurn({
      turnId: "turn-second",
      prompt: "unused",
      onEvent: () => ok(undefined),
    }));
    expect(second.isErr() && second.error).toMatchObject({ type: "acquire", error: { type: "session_busy" } });
    release();
    expect((await first).isOk()).toBe(true);
    expect((await supervisor.shutdown()).isOk()).toBe(true);
  });

  it("hands an active Session lease to neutralization before commit", { timeout: 10_000 }, async () => {
    const { root, supervisor } = await setup();
    let observed!: () => void;
    const active = new Promise<void>(resolve => { observed = resolve; });
    const lease = supervisor.withSessionLease(input(root, "restart-active", undefined, ["cancel-prompt"]), handle => handle.runTurn({
      turnId: "turn-active",
      prompt: "work until restart",
      onEvent: () => {
        observed();
        return ok(undefined);
      },
    }));
    await active;

    let commits = 0;
    const neutralized = await supervisor.withSessionsNeutralized({
      sessions: [{ runId: "run", agentSessionId: "session-restart-active" }],
      signal: new AbortController().signal,
    }, evidence => {
      commits += 1;
      expect(evidence).toEqual([expect.objectContaining({
        session: { runId: "run", agentSessionId: "session-restart-active" },
      })]);
      return ok("restarted");
    });

    expect(neutralized.isOk() && neutralized.value).toBe("restarted");
    expect(commits).toBe(1);
    expect((await lease).isErr()).toBe(true);
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect((await supervisor.shutdown()).isOk()).toBe(true);
  });

  it("returns typed open failure without invoking the callback", async () => {
    const { root, supervisor } = await setup();
    let called = false;
    const result = await supervisor.withSessionLease(input(root, "open-failure", undefined, ["exit-on-initialize"]), lease => {
      called = true;
      return lease.runTurn({ turnId: "unused", prompt: "unused", onEvent: () => ok(undefined) });
    });
    expect(called).toBe(false);
    expect(result.isErr() && result.error).toMatchObject({ type: "acquire" });
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect((await supervisor.shutdown()).isOk()).toBe(true);
  });

  it("allows Provider readiness to exceed the bootstrap orphan watchdog", { timeout: 15_000 }, async () => {
    const { root, supervisor } = await setup();
    const gateDirectory = join(root, "slow-ready-gate");
    vi.useFakeTimers();
    try {
      const result = supervisor.withSessionLease(input(root, "slow-ready", undefined, ["gate-initialize"], {
        ACP_FIXTURE_GATE_DIRECTORY: gateDirectory,
      }), lease => lease.runTurn({
        turnId: "turn-slow-ready",
        prompt: "work",
        onEvent: () => ok(undefined),
      }));
      await waitForPath(join(gateDirectory, "initialize.started"));
      await vi.advanceTimersByTimeAsync(5_100);
      vi.useRealTimers();
      await writeFile(join(gateDirectory, "initialize.release"), "");

      expect((await result).isOk()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(await directoryEntries(join(root, "workers"))).toEqual([]);
    expect((await supervisor.shutdown()).isOk()).toBe(true);
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acpus-process-capsule-"));
  roots.push(root);
  const created = await createAgentSessionSupervisor({
    workersRoot: join(root, "workers"),
    sessionStateDirectoryForRun: runId => join(root, "runs", runId),
    owner: { epoch: 1, pid: process.pid },
  });
  if (created.isErr()) throw new Error(created.error.message);
  return { root, supervisor: created.value };
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
