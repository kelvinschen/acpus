import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpTransport,
  AcpTransportNodeLive,
  type AcpTransportClientHandlers,
} from "../src/transport.js";

const fixtureAgent = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const cancellationFixture = fileURLToPath(new URL("./fixtures/acp-cancel-client-handler.mjs", import.meta.url));
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("AcpTransport", () => {
  it("adapts provider requests and ordered Session updates", async () => {
    const cwd = await workspace();
    const result = await run(Effect.gen(function*() {
      const transport = yield* AcpTransport;
      const connection = yield* transport.connect({
        launch: { kind: "argv", argv: [process.execPath, fixtureAgent] },
        cwd,
        handlers: unusedHandlers,
      });
      const initialized = yield* connection.initialize();
      const session = yield* connection.newSession(cwd);
      const update = yield* Effect.forkScoped(Stream.runHead(connection.updates));
      const prompt = yield* connection.prompt(session.sessionId, "hello");
      const observed = yield* Fiber.join(update);
      yield* connection.close();
      return {
        protocolVersion: initialized.protocolVersion,
        sessionId: session.sessionId,
        stopReason: prompt.response.stopReason,
        updateFence: prompt.updateFence,
        observed,
      };
    }));

    expect(result).toMatchObject({
      protocolVersion: 1,
      sessionId: "fixture-session",
      stopReason: "end_turn",
      updateFence: 1,
      observed: {
        _tag: "Some",
        value: {
          promptEpoch: 1,
          promptSequence: 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "reply|new|hello" },
          },
        },
      },
    });
  });

  it("gives provider exit priority over a broken request transport", async () => {
    const cwd = await workspace();
    const result = await run(Effect.gen(function*() {
      const transport = yield* AcpTransport;
      const connection = yield* transport.connect({
        launch: {
          kind: "argv",
          argv: [process.execPath, fixtureAgent, "--exit-initialize"],
        },
        cwd,
        handlers: unusedHandlers,
      });
      return yield* Effect.result(connection.initialize());
    }));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        type: "provider_exit",
        operation: "initialize",
        exitCode: 23,
      });
    }
  });

  it("maps provider spawn failure to AcpError", async () => {
    const cwd = await workspace();
    const result = await run(Effect.gen(function*() {
      const transport = yield* AcpTransport;
      return yield* Effect.result(transport.connect({
        launch: { kind: "argv", argv: [`missing-acp-provider-${process.pid}`] },
        cwd,
        handlers: unusedHandlers,
      }));
    }));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ type: "spawn", operation: "open_session", code: "ENOENT" });
    }
  });

  it("interrupts an outbound SDK request without waiting for its eventual Promise", async () => {
    const cwd = await workspace();
    const logPath = join(cwd, "requests.ndjson");
    await run(Effect.gen(function*() {
      const transport = yield* AcpTransport;
      const connection = yield* transport.connect({
        launch: {
          kind: "argv",
          argv: [process.execPath, fixtureAgent, "--hang-initialize"],
        },
        cwd,
        env: { ACP_FIXTURE_LOG_PATH: logPath },
        handlers: unusedHandlers,
      });
      const pending = yield* Effect.forkScoped(connection.initialize());
      const outbound = yield* Effect.promise(() => waitForWire(logPath, message => message.method === "initialize"));
      yield* Fiber.interrupt(pending);
      const interrupted = yield* Fiber.await(pending);
      const cancellation = yield* Effect.promise(() => waitForWire(logPath, message => message.method === "$/cancel_request"));

      expect(Exit.hasInterrupts(interrupted)).toBe(true);
      expect(cancellation.params).toEqual({ requestId: outbound.id });
    }));
  });

  it("interrupts an inbound client handler when the SDK cancels its request", async () => {
    const cwd = await workspace();
    let interrupted = false;
    await run(Effect.gen(function*() {
      const transport = yield* AcpTransport;
      const connection = yield* transport.connect({
        launch: { kind: "argv", argv: [process.execPath, cancellationFixture] },
        cwd,
        handlers: {
          ...unusedHandlers,
          waitForTerminalExit: () => Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })),
          ),
        },
      });
      yield* connection.initialize();
      const session = yield* connection.newSession(cwd);
      yield* connection.prompt(session.sessionId, "cancel client request");
    }));

    expect(interrupted).toBe(true);
  });

  it("interrupts pending inbound client handlers when the connection Scope closes", async () => {
    const cwd = await workspace();
    let interrupted = false;
    await run(Effect.gen(function*() {
      const transport = yield* AcpTransport;
      const started = yield* Deferred.make<void>();
      yield* Effect.scoped(Effect.gen(function*() {
        const connection = yield* transport.connect({
          launch: {
            kind: "argv",
            argv: [process.execPath, cancellationFixture, "--leave-client-handler-pending"],
          },
          cwd,
          handlers: {
            ...unusedHandlers,
            waitForTerminalExit: () => Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never.pipe(
                Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })),
              );
            }),
          },
        });
        yield* connection.initialize();
        const session = yield* connection.newSession(cwd);
        yield* Effect.forkScoped(connection.prompt(session.sessionId, "leave client request pending"));
        yield* Deferred.await(started);
      }));
    }));

    expect(interrupted).toBe(true);
  });
});

const unused = () => Effect.die(new Error("Unexpected ACP client callback."));

const unusedHandlers = {
  requestPermission: unused,
  readTextFile: unused,
  writeTextFile: unused,
  createTerminal: unused,
  terminalOutput: unused,
  waitForTerminalExit: unused,
  killTerminal: unused,
  releaseTerminal: unused,
} satisfies AcpTransportClientHandlers;

function run<Success, Failure>(effect: Effect.Effect<Success, Failure, AcpTransport | import("@acpus/owned-process").ProcessHost | import("effect/Scope").Scope>) {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(AcpTransportNodeLive))));
}

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acpus-acp-transport-"));
  workspaces.push(path);
  return path;
}

type WireMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

async function waitForWire(path: string, predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const messages = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as WireMessage);
      const matched = messages.find(predicate);
      if (matched !== undefined) return matched;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ACP wire message in ${path}.`);
}
