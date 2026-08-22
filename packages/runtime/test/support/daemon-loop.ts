import * as Effect from "effect/Effect";
import {
  startDaemonLoop as startDaemonLoopEffect,
  type DaemonLoopOptions,
} from "../../src/daemon/loop.js";

export async function startDaemonLoop(cwd: string, options: DaemonLoopOptions) {
  const loop = await Effect.runPromise(startDaemonLoopEffect(cwd, options));
  return {
    shutdown: () => Effect.runPromise(loop.shutdown()),
  };
}
