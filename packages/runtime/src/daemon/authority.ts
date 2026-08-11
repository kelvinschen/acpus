import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_LAYOUT_VERSION, type RuntimeLayout } from "../runtime-layout.js";
import { RUNTIME_STORAGE_VERSION } from "../storage/database.js";
import {
  RUNTIME_ABI_VERSION,
  type RuntimeAuthorityIdentity,
} from "./protocol.js";

export function createRuntimeAuthorityIdentity(
  layout: RuntimeLayout,
  leaseGeneration: number,
): RuntimeAuthorityIdentity {
  if (layout.generationId === undefined) {
    throw new Error("A daemon authority requires a published Runtime generation.");
  }
  const binding = createHash("sha256")
    .update(JSON.stringify({
      workspaceKey: layout.workspaceKey,
      generationId: layout.generationId,
      layoutVersion: RUNTIME_LAYOUT_VERSION,
      storageVersion: RUNTIME_STORAGE_VERSION,
    }))
    .digest("hex");
  return {
    workspaceKey: layout.workspaceKey,
    runtimeAbi: RUNTIME_ABI_VERSION,
    layoutVersion: RUNTIME_LAYOUT_VERSION,
    storageVersion: RUNTIME_STORAGE_VERSION,
    authorityId: randomUUID(),
    storeBinding: `sha256:${binding}`,
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
    && left.storeBinding === right.storeBinding
    && left.leaseGeneration === right.leaseGeneration;
}
