import fs from "node:fs/promises";
import path from "node:path";
import type { AttemptIndexEntry, AttemptStatus, RunIndex } from "../run-index/read-write.js";

export type AttemptKind = "attempt" | "repair" | "diagnostic";

export function attemptId(input: { stageId: string; kind: AttemptKind; ordinal: number; itemId?: string; runtimeRetryOrdinal?: number }): string {
  const prefix = input.itemId ? `${input.stageId}:${input.itemId}` : input.stageId;
  const retrySuffix = input.runtimeRetryOrdinal ? `-runtime-retry-${input.runtimeRetryOrdinal}` : "";
  return `${prefix}:${input.kind}-${input.ordinal}${retrySuffix}`;
}

export function attemptDir(runDir: string, input: { stageId: string; kind: AttemptKind; ordinal: number; itemId?: string; runtimeRetryOrdinal?: number }): string {
  const retrySuffix = input.runtimeRetryOrdinal ? `-runtime-retry-${input.runtimeRetryOrdinal}` : "";
  const leaf = `${input.kind}-${input.ordinal}${retrySuffix}`;
  if (input.itemId) return path.join(runDir, "attempts", input.stageId, `item-${safeFileName(input.itemId)}`, leaf);
  return path.join(runDir, "attempts", input.stageId, leaf);
}

export async function writeAttemptFile(dir: string, name: "prompt.md" | "raw.txt" | "parse.json" | "output.json", value: string | unknown): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
  return filePath;
}

export function upsertAttemptIndex(index: RunIndex, entry: Omit<AttemptIndexEntry, "path"> & { path: string }): RunIndex {
  const attempts = {
    ...index.attempts,
    [entry.id]: entry
  };
  const stage = index.stages[entry.stageId];
  const stages = stage
    ? {
        ...index.stages,
        [entry.stageId]: {
          ...stage,
          attempts: stage.attempts.includes(entry.id) ? stage.attempts : [...stage.attempts, entry.id]
        }
      }
    : index.stages;
  return { ...index, attempts, stages };
}

export function updateAttemptStatus(index: RunIndex, id: string, status: AttemptStatus, extra: Partial<AttemptIndexEntry> = {}): RunIndex {
  const current = index.attempts[id];
  if (!current) return index;
  return {
    ...index,
    attempts: {
      ...index.attempts,
      [id]: {
        ...current,
        ...extra,
        status
      }
    }
  };
}

export function previewText(value: string, limit = 2048): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... [truncated]` : value;
}

export function safeFileName(value: string): string {
  return String(value || "item").replace(/[^A-Za-z0-9_.-]/g, "_");
}
