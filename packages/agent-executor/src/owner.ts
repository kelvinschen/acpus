import type { ProcessHostShape } from "@acpus/owned-process";
import * as Effect from "effect/Effect";
import type { RuntimeOwnerIdentity } from "./types.js";

export type NormalizedRuntimeOwnerIdentity = {
  pid: number;
  startToken?: string;
  epoch: number;
};

export function normalizeRuntimeOwner(
  owner: RuntimeOwnerIdentity,
  processes: ProcessHostShape,
): Effect.Effect<NormalizedRuntimeOwnerIdentity> {
  return Effect.gen(function*() {
    const startToken = owner.startToken ?? (yield* processes.startToken(owner.pid));
    return {
      pid: owner.pid,
      ...(startToken === undefined ? {} : { startToken }),
      epoch: owner.epoch,
    };
  });
}
