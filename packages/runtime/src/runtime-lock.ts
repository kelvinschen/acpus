import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  openRuntimeExclusiveLock,
  openRuntimeSharedLock,
  type RuntimeExclusiveLock,
  type RuntimeSharedLock,
} from "./runtime-lock-adapter.js";
import type { RuntimeLayout } from "./runtime-layout.js";

export {
  RuntimeLockTimeoutError,
  type RuntimeExclusiveLock,
  type RuntimeSharedLock,
} from "./runtime-lock-adapter.js";

export function acquireRuntimeSharedLock(
  layout: RuntimeLayout,
): Effect.Effect<RuntimeSharedLock, unknown, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openRuntimeSharedLock(layout),
      catch: error => error,
    }),
    lock => Effect.sync(() => lock.release()),
  );
}

export function acquireRuntimeExclusiveLock(
  layout: RuntimeLayout,
): Effect.Effect<RuntimeExclusiveLock, unknown, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openRuntimeExclusiveLock(layout),
      catch: error => error,
    }),
    lock => Effect.promise(() => lock.release()).pipe(Effect.orDie),
  );
}
