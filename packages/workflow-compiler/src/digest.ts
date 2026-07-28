import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableJsonLine(value: unknown): string {
  const json = JSON.stringify(sortJson(value));
  if (json === undefined) throw new Error("Stable JSON root is not serializable.");
  return `${json}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
