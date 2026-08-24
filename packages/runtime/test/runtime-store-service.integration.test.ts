import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  acquireRuntimeStore,
  RuntimeStore,
  runtimeStoreLayer,
  type RuntimeStoreShape,
} from "../src/store/service.js";
import { withRuntimeWorkspace } from "./support/runtime-harness.js";

describe("RuntimeStore Effect service", () => {
  it("provides the live service through one Layer", async () => {
    await withRuntimeWorkspace("runtime-store-service-layer", async workspace => {
      const runs = await Effect.runPromise(Effect.gen(function* () {
        const store = yield* RuntimeStore;
        return yield* store.listRuns();
      }).pipe(Effect.provide(runtimeStoreLayer(workspace))));

      expect(runs).toEqual([]);
    });
  });

  it("closes the adapter when its Scope succeeds or fails", async () => {
    await withRuntimeWorkspace("runtime-store-service-finalizer", async workspace => {
      let succeeded!: RuntimeStoreShape;
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        succeeded = yield* acquireRuntimeStore(workspace);
        yield* succeeded.listRuns();
      })));
      await expectClosed(succeeded);

      let failed!: RuntimeStoreShape;
      const result = await Effect.runPromise(Effect.result(Effect.scoped(Effect.gen(function* () {
        failed = yield* acquireRuntimeStore(workspace);
        return yield* Effect.fail("expected" as const);
      }))));
      expect(Result.isFailure(result) ? result.failure : undefined).toBe("expected");
      await expectClosed(failed);
    });
  });

  it("closes the adapter when the owning Fiber is interrupted", async () => {
    await withRuntimeWorkspace("runtime-store-service-interrupt", async workspace => {
      const leaked = await Effect.runPromise(Effect.gen(function* () {
        const acquired = yield* Deferred.make<RuntimeStoreShape>();
        const fiber = yield* Effect.scoped(Effect.gen(function* () {
          const store = yield* acquireRuntimeStore(workspace);
          yield* Deferred.succeed(acquired, store);
          return yield* Effect.never;
        })).pipe(Effect.forkChild({ startImmediately: true }));
        const store = yield* Deferred.await(acquired);
        yield* Fiber.interrupt(fiber);
        return store;
      }));

      await expectClosed(leaked);
    });
  });
});

async function expectClosed(store: RuntimeStoreShape): Promise<void> {
  await expect(Effect.runPromise(store.listRuns())).rejects.toThrow();
}
