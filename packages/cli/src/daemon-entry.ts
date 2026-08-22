#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { startDaemonLoop } from "@acpus/runtime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import { getCliPackageInfo } from "./platform/package-info.js";

const [cwdArg, heartbeatMsArg] = process.argv.slice(2);
const cwd = cwdArg ?? process.cwd();
const heartbeatMs = Number(heartbeatMsArg ?? 1_000);

const main = Effect.scoped(Effect.gen(function*() {
  const stopped = yield* Deferred.make<void>();
  yield* Effect.acquireRelease(
    startDaemonLoop(cwd, {
      heartbeatMs,
      packageVersion: getCliPackageInfo().version,
      onShutdown: () => {
        Deferred.doneUnsafe(stopped, Effect.void);
      },
    }),
    loop => loop.shutdown().pipe(Effect.orDie),
  );
  yield* Deferred.await(stopped);
}));

const gracefulDaemonTeardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    onExit(0);
  } else {
    Runtime.defaultTeardown(exit, onExit);
  }
};

NodeRuntime.runMain(main, { teardown: gracefulDaemonTeardown });
