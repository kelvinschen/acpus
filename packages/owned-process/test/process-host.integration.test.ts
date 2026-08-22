import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { NodeProcessHostLive, ProcessHost } from "../src/index.js";

describe("ProcessHost", () => {
  it("adapts stdout and one process exit", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      const handle = yield* processes.spawn({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("hello"); process.exit(7)'],
        stdin: "ignore",
      });
      const output = yield* Effect.forkScoped(Stream.runCollect(handle.stdout));
      const closed = yield* handle.closed;
      const chunks = yield* Fiber.join(output);
      return { closed, output: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8") };
    }).pipe(Effect.provide(NodeProcessHostLive))));

    expect(result).toEqual({
      closed: { exitCode: 7, signal: null },
      output: "hello",
    });
  });

  it("adapts IPC messages and sends", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      const handle = yield* processes.spawn({
        command: process.execPath,
        args: [
          "-e",
          "process.on('message', value => process.send?.({ echo: value }, () => process.exit(0)))",
        ],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ipc: true,
      });
      const message = yield* Effect.forkScoped(Stream.runHead(handle.messages));
      yield* handle.send({ value: 42 });
      const received = yield* Fiber.join(message);
      yield* handle.closed;
      return received;
    }).pipe(Effect.provide(NodeProcessHostLive))));

    expect(result).toMatchObject({ _tag: "Some", value: { echo: { value: 42 } } });
  });

  it("reports synchronous IPC serialization failures in the typed channel", async () => {
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      const handle = yield* processes.spawn({
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 10_000)"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ipc: true,
      });
      const circular: { self?: unknown } = {};
      circular.self = circular;
      return yield* Effect.exit(handle.send(circular));
    }).pipe(Effect.provide(NodeProcessHostLive))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ type: "process", operation: "ipc" });
    }
  });

  it("reports spawn failure in the typed channel", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      return yield* processes.spawn({ command: `missing-acpus-process-${process.pid}` });
    }).pipe(Effect.provide(NodeProcessHostLive))));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ type: "process", operation: "spawn", code: "ENOENT" });
    }
  });

  it("force-signals a still-running child when its Scope closes", async () => {
    const pid = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      const handle = yield* processes.spawn({
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 10_000)"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: process.platform !== "win32",
      });
      return handle.pid;
    }).pipe(Effect.provide(NodeProcessHostLive))));

    await expectDead(pid);
  });

  it("treats signalling an already-exited process as success", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      const handle = yield* processes.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      yield* handle.closed;
      yield* handle.signal("SIGTERM");
    }).pipe(Effect.provide(NodeProcessHostLive))));
  });

  it("preserves process start identity evidence", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const processes = yield* ProcessHost;
      const token = yield* processes.startToken(process.pid);
      const liveness = yield* processes.identityLiveness(process.pid, token);
      return { token, liveness };
    }).pipe(Effect.provide(NodeProcessHostLive)));

    if (process.platform === "linux") {
      expect(result.token).toMatch(/^linux:\d+$/u);
      expect(result.liveness).toBe("match");
    } else {
      expect(result).toEqual({ token: undefined, liveness: "unverified" });
    }
  });
});

async function expectDead(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect.fail(`Process '${pid}' remained alive after Scope finalization.`);
}
