import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
