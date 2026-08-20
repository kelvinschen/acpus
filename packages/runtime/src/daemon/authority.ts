import { RUNTIME_LAYOUT_VERSION, type RuntimeLayout } from "../runtime-layout.js";
import { RUNTIME_STORAGE_VERSION } from "../storage/database.js";
import {
  RUNTIME_ABI_VERSION,
  type RuntimeAuthorityIdentity,
} from "../runtime-contracts.js";

export function createRuntimeAuthorityIdentity(
  layout: RuntimeLayout,
  authorityId: string,
  leaseGeneration: number,
): RuntimeAuthorityIdentity {
  if (layout.generationId === undefined) {
    throw new Error("Runtime authority requires a published Runtime generation.");
  }
  return {
    workspaceKey: layout.workspaceKey,
    runtimeAbi: RUNTIME_ABI_VERSION,
    layoutVersion: RUNTIME_LAYOUT_VERSION,
    storageVersion: RUNTIME_STORAGE_VERSION,
    authorityId,
    leaseGeneration,
  };
}

export function sameRuntimeAuthority(
  left: RuntimeAuthorityIdentity,
  right: RuntimeAuthorityIdentity,
): boolean {
  return left.workspaceKey === right.workspaceKey
    && left.runtimeAbi === right.runtimeAbi
    && left.layoutVersion === right.layoutVersion
    && left.storageVersion === right.storageVersion
    && left.authorityId === right.authorityId
    && left.leaseGeneration === right.leaseGeneration;
}
