import { processStartToken } from "./process-tree.js";
import type { RuntimeOwnerIdentity } from "./types.js";

export type NormalizedRuntimeOwnerIdentity = {
  pid: number;
  startToken?: string;
  epoch: number;
};

export async function normalizeRuntimeOwner(
  owner: RuntimeOwnerIdentity,
): Promise<NormalizedRuntimeOwnerIdentity> {
  const pid = owner.pid;
  const startToken = owner.startToken ?? await processStartToken(pid);
  return {
    pid,
    ...(startToken === undefined ? {} : { startToken }),
    epoch: owner.epoch,
  };
}
