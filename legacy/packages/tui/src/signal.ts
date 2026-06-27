/**
 * Signal Node payload entry helpers for the TUI.
 *
 * A Signal Node awaiting an external decision is resolved by delivering a JSON
 * payload. Two entry modes:
 *  - Trivial schema (a single required boolean field): a y/N quick prompt maps
 *    to `{ field: true|false }` without leaving the TUI.
 *  - Everything else (no schema, or a richer schema): the operator's `$EDITOR`
 *    is launched on a pre-filled skeleton; the saved JSON is the payload.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Compiled output schema as stored in IR node metadata (or undefined). */
export type SignalOutputSchema = Record<string, unknown> | undefined;

/**
 * If the schema is exactly one required boolean field, return its name so the
 * TUI can offer a y/N quick prompt. Otherwise undefined (use the editor).
 */
export function singleBooleanField(schema: SignalOutputSchema): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required as string[] | undefined;
  if (!properties) return undefined;
  const keys = Object.keys(properties);
  if (keys.length !== 1) return undefined;
  const field = keys[0];
  const prop = properties[field] as Record<string, unknown> | undefined;
  if (!prop || prop.type !== "boolean") return undefined;
  if (!Array.isArray(required) || !required.includes(field)) return undefined;
  return field;
}

/**
 * Build a JSON skeleton for the editor from the compiled output schema. When no
 * schema is declared the node accepts any payload, so we seed an empty object.
 */
export function payloadSkeleton(schema: SignalOutputSchema): string {
  if (!schema || typeof schema !== "object") return "{}\n";
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || Object.keys(properties).length === 0) return "{}\n";
  const skeleton: Record<string, unknown> = {};
  for (const [field, prop] of Object.entries(properties)) {
    skeleton[field] = sampleForType(prop?.type);
  }
  return JSON.stringify(skeleton, null, 2) + "\n";
}

function sampleForType(type: unknown): unknown {
  switch (type) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

/**
 * Launch `$EDITOR` (falling back to common editors) on a skeleton file and
 * return the parsed JSON object. Returns undefined when the editor exits
 * non-zero, or throws when the saved content is not a JSON object so the caller
 * can surface the parse error and let the operator retry.
 *
 * The caller is responsible for releasing Ink's raw-mode hold on stdin around
 * this synchronous, stdio-inheriting spawn.
 */
export function launchPayloadEditor(schema: SignalOutputSchema): Record<string, unknown> | undefined {
  const editor = process.env.ACPUS_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const dir = mkdtempSync(join(tmpdir(), "acpus-signal-"));
  try {
    const file = join(dir, "payload.json");
    writeFileSync(file, payloadSkeleton(schema), "utf8");

    const [cmd, ...preArgs] = editor.split(/\s+/).filter(Boolean);
    const result = spawnSync(cmd, [...preArgs, file], { stdio: "inherit" });
    if (result.status !== 0 || result.error) {
      return undefined;
    }

    const raw = readFileSync(file, "utf8").trim();
    if (raw === "") return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Signal payload must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } finally {
    // Always remove the scratch dir, even when the editor is cancelled or the
    // payload fails to parse.
    rmSync(dir, { recursive: true, force: true });
  }
}
