import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function sha256Digest(content: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

export function sha256DigestHex(value: Sha256Digest): string {
  if (!isSha256Digest(value)) throw new TypeError("Expected a lowercase SHA-256 content digest.");
  return value.slice("sha256:".length);
}

export function workflowSourceGraphDigest(
  entry: string,
  files: readonly {
    readonly path: string;
    readonly digest: Sha256Digest;
  }[],
): Sha256Digest {
  const envelope = {
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files: [...files]
      .sort((left, right) => compareCodeUnits(left.path, right.path))
      .map(file => ({ path: file.path, digest: file.digest })),
  };
  return sha256Digest(`${JSON.stringify(sortJson(envelope))}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
