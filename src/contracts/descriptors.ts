import { z } from "zod";
import { minimalExampleForContract } from "./examples.js";
import { describeZodIssue, type FixHint } from "./repair-hints.js";
import { schemaForContract, type OutputContractName } from "./schemas.js";

export type OutputContract = {
  name: OutputContractName;
  schema: z.ZodType;
  schemaForPrompt: unknown;
  minimalExample: unknown;
  describeIssue(issue: z.core.$ZodIssue): FixHint;
  footerText(): string;
};

export type OutputContractOptions = {
  outputKey?: string;
  maxItems?: number;
};

export function getOutputContract(name: OutputContractName, options: OutputContractOptions = {}): OutputContract {
  const schemaForPrompt = schemaDescriptor(name, options);
  return {
    name,
    schema: schemaForContract(name, options),
    schemaForPrompt,
    minimalExample: minimalExampleForContract(name, options),
    describeIssue: describeZodIssue,
    footerText: () => contractFooterText(name, schemaForPrompt, options)
  };
}

export function contractFooterText(name: OutputContractName, schemaForPrompt = schemaDescriptor(name), options: OutputContractOptions = {}): string {
  void name;
  void options;
  return [
    "Output contract:",
    "- **Response with exactly one valid, parseable JSON object that satisfies the schema**.",
    "- Do not wrap the final JSON object in Markdown code fences, especially ```json.",
    "- Required schema:",
    "```json",
    JSON.stringify(schemaForPrompt, null, 2),
    "```"
  ].join("\n");
}

export function schemaDescriptor(name: OutputContractName, options: OutputContractOptions = {}): unknown {
  const base = {
    status: '"completed" | "blocked"',
    summary: "string",
    artifacts: "Array<{ kind?: string; path?: string; url?: string; label?: string }>",
    nextFocus: "string",
    blockedReason: "string optional when status is blocked",
    data: "object optional"
  };
  if (name === "implementation") {
    return {
      ...base,
      changedFiles: "string[]",
      checks: 'Array<{ command?: string; name?: string; status: "pass" | "fail" | "skipped" | "unknown"; summary?: string }>'
    };
  }
  if (name === "validation") {
    return {
      ...base,
      verdict: '"pass" | "fix" | "blocked" | "unknown"',
      severityCounts: "{ P0: number; P1: number; P2: number; P3: number }",
      findings: 'Array<{ severity: "P0" | "P1" | "P2" | "P3"; summary: string; path?: string; details?: string }>',
      checks: 'Array<{ command?: string; name?: string; status: "pass" | "fail" | "skipped" | "unknown"; summary?: string }>'
    };
  }
  if (name === "decision") {
    return {
      ...base,
      route: "string"
    };
  }
  if (name === "discover") {
    return {
      ...base,
      [options.outputKey ?? "items"]: "array"
    };
  }
  if (name === "gate") {
    return {
      ...base,
      verdict: '"pass" | "pass_with_warnings" | "blocked" | "failed" | "unknown"',
      deliverables: "string[]",
      changedFiles: "string[]",
      checks: 'Array<{ command?: string; name?: string; status: "pass" | "fail" | "skipped" | "unknown"; summary?: string }>',
      warnings: "string[]",
      risks: "string[]",
      nextActions: "string[]"
    };
  }
  if (name === "diagnostic") {
    return {
      ...base,
      data: "{ blockedCause?: string; recoveryAdvice?: string[]; requiresNewRun?: boolean; [key: string]: unknown }"
    };
  }
  return base;
}
