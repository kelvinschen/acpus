import { basename } from "node:path";
import { isCancel, select } from "@clack/prompts";
import type { AvailableWorkflowCatalogEntry, WorkflowCatalogEntry } from "./catalog.js";
import { clearSubmittedSelect, type PromptIo } from "../presentation/prompt.js";

export async function pickWorkflowCatalogEntry(
  entries: WorkflowCatalogEntry[],
  io: PromptIo,
): Promise<AvailableWorkflowCatalogEntry | undefined> {
  const picked = await select<number>({
    message: "Select a workflow:",
    options: entries.map((entry, index) => ({
      value: index,
      label: entry.status === "available" && entry.requiresScope
        ? `${entry.name} (${entry.scope})`
        : entry.name ?? basename(entry.packagePath),
      hint: entry.status === "available"
        ? entry.requiresScope ? "scope required" : entry.scope
        : `${entry.scope} · ${entry.errorCode}`,
      ...(entry.status === "invalid" ? { disabled: true } : {}),
    })),
    input: io.stdin,
    output: io.stderr,
  });
  if (isCancel(picked)) return undefined;
  const entry = entries[picked];
  if (entry?.status !== "available") throw new Error("Clack selected a disabled workflow catalog entry.");
  clearSubmittedSelect(io.stderr);
  return entry;
}
