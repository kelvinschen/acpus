import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { inspectRun } from "../src/mcp/inspection.js";
import { settleMutation } from "../src/mcp/mutation.js";

const runtime = vi.hoisted(() => ({ observeInspection: vi.fn(), readInspection: vi.fn() }));
vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  ...runtime,
}));

it.effect("bounds observation, releases its stream, and reads a fresh snapshot on timeout", () => Effect.gen(function* () {
  const attached = yield* Deferred.make<void>();
  let released = false;
  const latest = { kind: "run", run: { id: "run-1", status: "running" } };
  runtime.observeInspection.mockReturnValue(Stream.fromEffect(Deferred.succeed(attached, undefined)).pipe(
    Stream.flatMap(() => Stream.never),
    Stream.ensuring(Effect.sync(() => { released = true; })),
  ));
  runtime.readInspection.mockReturnValue(Effect.succeed(latest));
  const waiting = yield* Effect.forkChild(inspectRun("/workspace", { kind: "run", runId: "run-1" }, "terminal"));
  yield* Deferred.await(attached);
  yield* TestClock.adjust(30_000);
  expect(yield* Fiber.join(waiting)).toEqual({ view: latest, timedOut: true });
  expect(released).toBe(true);
}));

it.effect("returns the authoritative decision snapshot before the observation deadline", () => Effect.gen(function* () {
  const view = { kind: "run", run: { id: "run-1", status: "awaiting" } };
  runtime.observeInspection.mockReturnValue(Stream.make({ kind: "closed", reason: "awaiting-input", view }));
  expect(yield* inspectRun("/workspace", { kind: "run", runId: "run-1" }, "decision"))
    .toEqual({ view, reason: "awaiting-input", timedOut: false });
}));

it.effect("reconfirms the same mutation after request cancellation without duplicating durable work", () => Effect.gen(function* () {
  const committed = yield* Deferred.make<void>();
  const receipts = new Map<string, { run: { id: string } }>();
  let requests = 0;
  const operation = Effect.gen(function* () {
    requests++;
    const prior = receipts.get("request-1");
    if (prior) return prior;
    receipts.set("request-1", { run: { id: "run-1" } });
    yield* Deferred.succeed(committed, undefined);
    return yield* Effect.never;
  });
  const running = yield* Effect.forkChild(settleMutation(operation));
  yield* Deferred.await(committed);
  yield* Fiber.interrupt(running);
  expect(requests).toBe(2);
  expect([...receipts.values()]).toEqual([{ run: { id: "run-1" } }]);
}));

it.effect("bounds detached mutation confirmation when the authority is unavailable", () => Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const replayed = yield* Deferred.make<void>();
  let requests = 0;
  const operation = Effect.gen(function* () {
    yield* Deferred.succeed(++requests === 1 ? started : replayed, undefined);
    return yield* Effect.never;
  });
  const running = yield* Effect.forkChild(settleMutation(operation));
  yield* Deferred.await(started);
  const stopping = yield* Effect.forkChild(Fiber.interrupt(running));
  yield* Deferred.await(replayed);
  yield* TestClock.adjust(30_000);
  yield* Fiber.join(stopping);
  expect(requests).toBe(2);
}));
