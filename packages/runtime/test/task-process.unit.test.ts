import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Handler = (...args: any[]) => void;

  class FakeEmitter {
    private readonly handlers = new Map<string, Handler[]>();

    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    once(event: string, handler: Handler): this {
      const wrapped = (...args: any[]) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter(current => current !== wrapped));
        handler(...args);
      };
      return this.on(event, wrapped);
    }

    emit(event: string, ...args: any[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  class FakeChild extends FakeEmitter {
    readonly connected = true;
    readonly pid = 123;
    readonly stdout = new FakeEmitter();
    readonly stderr = new FakeEmitter();
    readonly sent: unknown[] = [];

    send(message: unknown, callback?: (error: Error | null) => void): void {
      this.sent.push(message);
      callback?.(null);
    }
  }

  const state: {
    now: number;
    spawnElapsedMs: number;
    spawnError: Error | undefined;
    duringSpawn: (() => void) | undefined;
    child: FakeChild | undefined;
    afterSpawn: ((child: FakeChild) => void) | undefined;
  } = {
    now: 0,
    spawnElapsedMs: 0,
    spawnError: undefined,
    duringSpawn: undefined,
    child: undefined,
    afterSpawn: undefined,
  };
  return {
    state,
    spawn: vi.fn(() => {
      state.now += state.spawnElapsedMs;
      state.duringSpawn?.();
      if (state.spawnError) throw state.spawnError;
      const child = new FakeChild();
      state.child = child;
      queueMicrotask(() => {
        child.emit("spawn");
        state.afterSpawn?.(child);
      });
      return child;
    }),
  };
});

vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

import { runTaskAttempt } from "../src/execution/task-process.js";

describe("task process timeout budget", () => {
  beforeEach(() => {
    fake.state.now = 0;
    fake.state.spawnElapsedMs = 0;
    fake.state.spawnError = undefined;
    fake.state.duringSpawn = undefined;
    fake.state.child = undefined;
    fake.state.afterSpawn = undefined;
    fake.spawn.mockClear();
    vi.spyOn(globalThis.performance, "now").mockImplementation(() => fake.state.now);
  });

  afterEach(() => vi.restoreAllMocks());

  it("times out when synchronous spawn exhausts the remaining budget and rejects late success", async () => {
    fake.state.spawnElapsedMs = 11;
    fake.state.afterSpawn = child => {
      child.emit("message", { type: "completed", hasOutput: true, output: { late: true } });
      child.emit("close", 0, null);
    };
    const result = await runTaskAttempt(taskInput("slow_spawn"));

    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "timed_out" });
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(fake.state.child?.sent).toContainEqual({ type: "abort" });
  });

  it("rejects completion and artifact registration after the deadline when the timer callback is delayed", async () => {
    const registerArtifact = vi.fn();
    const result = runTaskAttempt(taskInput("late_message", { registerArtifact }));
    const child = fake.state.child!;
    child.emit("spawn");
    fake.state.now = 11;
    child.emit("message", {
      type: "artifact_register",
      requestId: "artifact_1",
      artifact: {
        id: "artifact_1",
        runId: "run_1",
        nodeKey: "late_message",
        attempt: 1,
        digest: "sha256:late",
        size: 1,
        relativePath: "artifacts/late.txt",
      },
    });
    child.emit("message", { type: "completed", hasOutput: true, output: { late: true } });
    child.emit("close", 0, null);

    expect((await result)._unsafeUnwrapErr()).toMatchObject({ type: "timed_out" });
    expect(registerArtifact).not.toHaveBeenCalled();
    expect(child.sent).toContainEqual(expect.objectContaining({ type: "artifact_result", requestId: "artifact_1", ok: false }));
    expect(child.sent).toContainEqual({ type: "abort" });
  });

  it("lets an exhausted deadline win over a synchronous spawn failure", async () => {
    fake.state.spawnElapsedMs = 11;
    fake.state.spawnError = new Error("late spawn failure");

    const result = await runTaskAttempt(taskInput("failed_spawn"));

    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "timed_out" });
  });

  it("lets cancellation win when synchronous spawn aborts and then fails after the deadline", async () => {
    const controller = new AbortController();
    fake.state.spawnElapsedMs = 11;
    fake.state.duringSpawn = () => controller.abort();
    fake.state.spawnError = new Error("late spawn failure");

    const result = await runTaskAttempt(taskInput("cancelled_spawn", { signal: controller.signal }));

    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "cancelled" });
  });

  it.each([
    { name: "task failure", event: "message", value: { type: "failed", error: { message: "late task failure" } } },
    { name: "child error", event: "error", value: new Error("late child error") },
  ])("lets an exhausted deadline win over a delayed $name", async ({ event, value }) => {
    const result = runTaskAttempt(taskInput("late_failure"));
    const child = fake.state.child!;
    child.emit("spawn");
    fake.state.now = 11;
    child.emit(event, value);
    child.emit("close", 1, null);

    expect((await result)._unsafeUnwrapErr()).toMatchObject({ type: "timed_out" });
  });

  it("lets an exhausted deadline override a previously reported completion", async () => {
    const result = runTaskAttempt(taskInput("late_close"));
    const child = fake.state.child!;
    child.emit("spawn");
    child.emit("message", { type: "completed", hasOutput: true, output: { early: true } });
    fake.state.now = 11;
    child.emit("close", 0, null);

    expect((await result)._unsafeUnwrapErr()).toMatchObject({ type: "timed_out" });
  });
});

function taskInput(
  nodeId: string,
  overrides: Partial<Parameters<typeof runTaskAttempt>[0]> = {},
): Parameters<typeof runTaskAttempt>[0] {
  return {
    nodeId,
    cwd: "/repo",
    env: {},
    request: {
      target: { kind: "inline", source: "async () => undefined" },
      input: {},
      workspaceDir: "/repo",
      artifact: { runId: "run_1", nodeKey: nodeId, attempt: 1, runDir: "/repo/.acpus/run_1", paths: {} },
    },
    timeoutMs: 10,
    registerArtifact: vi.fn(),
    ...overrides,
  };
}
