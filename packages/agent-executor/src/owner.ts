import { processStartToken } from "./process-tree.js";
import type { ManagedAcpExecutorOptions } from "./types.js";

export type AcpExecutorOwnerIdentity = {
  pid: number;
  startToken?: string;
  generation: string;
};

export async function normalizeAcpExecutorOwner(
  owner: ManagedAcpExecutorOptions["owner"],
): Promise<AcpExecutorOwnerIdentity> {
  const pid = owner.pid ?? process.pid;
  const startToken = owner.startToken ?? await processStartToken(pid);
  return {
    pid,
    ...(startToken === undefined ? {} : { startToken }),
    generation: String(owner.generation),
  };
}
