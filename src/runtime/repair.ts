import { getOutputContract, type OutputContractName } from "../contracts/output-contracts.js";
import type { OutputParseFailure } from "./output-parser.js";

export function isRepairableOutputFailure(reason: string | undefined): boolean {
  return reason === "OUTPUT_PARSE_FAILED" || reason === "OUTPUT_SCHEMA_FAILED";
}

export function formatRepairPrompt(input: {
  contractName: OutputContractName;
  failure: OutputParseFailure;
  contractOptions?: { outputKey?: string; maxItems?: number };
}): string {
  const contract = getOutputContract(input.contractName, input.contractOptions);
  const best = input.failure.bestCandidate;
  const issueHints = (best?.schemaErrors ?? [])
    .slice(0, 12)
    .map((issue) => `- ${issue.path}: ${issue.message}`)
    .join("\n") || "- Produce an object matching the required schema.";
  const bestBody = best?.normalizedPreview ?? best?.rawPreview ?? "(no parseable candidate body)";

  return [
    "You are repairing only the final JSON output contract for the previous agent response.",
    "",
    "Do not redo task work. Do not edit files. Do not invent command results. Do not change factual content except to convert it into the required schema.",
    "End with exactly one valid, parseable JSON object that satisfies the schema.",
    "Do not wrap the final JSON object in Markdown code fences. Do not use ```json.",
    "",
    `Contract: ${input.contractName}`,
    "Canonical schema:",
    "```json",
    JSON.stringify(contract.schemaForPrompt, null, 2),
    "```",
    "Minimal valid example:",
    "```json",
    JSON.stringify(contract.minimalExample, null, 2),
    "```",
    "Allowed deterministic aliases:",
    ...contract.aliases.map((alias) => `- ${alias.from} -> ${alias.to}: ${alias.description}`),
    "",
    `Blocked reason: ${input.failure.errorCode}`,
    `Candidate count: ${input.failure.diagnostics.candidateCount}`,
    "Fix these issues:",
    issueHints,
    "",
    "Best candidate or raw body:",
    "```json",
    bestBody,
    "```"
  ].join("\n");
}

export function repairFailedEnvelope(input: {
  summary: string;
  originalReason: string;
  repairDiagnostics: unknown;
}): Record<string, unknown> {
  return {
    status: "blocked",
    summary: input.summary,
    artifacts: [],
    nextFocus: "Review blocked workflow output",
    blockedReason: "OUTPUT_REPAIR_FAILED",
    originalBlockedReason: input.originalReason,
    parseDiagnostics: input.repairDiagnostics,
    metadata: {
      repairAttempts: 1
    }
  };
}
