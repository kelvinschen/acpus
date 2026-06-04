import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowSpec } from "../schema/workflow-spec.js";

export async function readFinalOutput(dir: string, spec: WorkflowSpec): Promise<Record<string, unknown> | undefined> {
  const gate = spec.stages.find((stage) => stage.kind === "gate");
  if (!gate) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, "outputs", `${gate.id}.json`), "utf8")) as unknown;
    return objectRecord(parsed);
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
