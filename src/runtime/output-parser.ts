import crypto from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { getOutputContract, normalizeDeterministicAliases, type AliasNormalization, type OutputContractName } from "../contracts/output-contracts.js";

export type OutputParseErrorCode =
  | "OK"
  | "OUTPUT_PARSE_FAILED"
  | "OUTPUT_SCHEMA_FAILED";

export type OutputCandidateMode = "lastBalancedJson";

export type OutputCandidateSyntax = "invalidJson" | "validJson" | "repairedJson";

export type OutputCandidateDiagnostic = {
  id: string;
  mode: OutputCandidateMode;
  syntax: OutputCandidateSyntax;
  rawHash: string;
  rawPreview: string;
  normalizedPreview?: string;
  repairedPreview?: string;
  parseError?: string;
  schemaErrors: Array<{ path: string; message: string }>;
  aliasNormalizations: AliasNormalization[];
  valid: boolean;
  value?: unknown;
};

export type OutputParseDiagnostics = {
  errorCode: OutputParseErrorCode;
  summary: string;
  candidateCount: number;
  bestCandidateId?: string;
  recoverability: "repairable" | "not_repairable";
  candidates: OutputCandidateDiagnostic[];
  warnings: string[];
};

export type OutputParseSuccess = {
  ok: true;
  value: Record<string, unknown>;
  outputParse: {
    mode: OutputCandidateMode;
    repaired: boolean;
    candidateCount: number;
    warnings: string[];
    outputNormalizedAliases: string[];
  };
  diagnostics: OutputParseDiagnostics;
};

export type OutputParseFailure = {
  ok: false;
  errorCode: Exclude<OutputParseErrorCode, "OK">;
  summary: string;
  diagnostics: OutputParseDiagnostics;
  bestCandidate?: OutputCandidateDiagnostic;
};

export type OutputParseResult = OutputParseSuccess | OutputParseFailure;

export type ParseWorkflowOutputOptions = {
  contractOptions?: {
    outputKey?: string;
    maxItems?: number;
  };
  maxOutputChars?: number;
};

type RawCandidate = {
  id: string;
  mode: OutputCandidateMode;
  raw: string;
  start: number;
  end: number;
};

const PREVIEW_CHARS = 2000;

export function parseWorkflowOutput(text: string, contractName: OutputContractName, options: ParseWorkflowOutputOptions = {}): OutputParseResult {
  const source = String(text ?? "");
  if (typeof options.maxOutputChars === "number" && source.length > options.maxOutputChars) {
    const diagnostics = createDiagnostics({
      errorCode: "OUTPUT_PARSE_FAILED",
      summary: `Agent output exceeded maxOutputChars (${options.maxOutputChars}).`,
      candidates: [],
      recoverability: "not_repairable"
    });
    return { ok: false, errorCode: "OUTPUT_PARSE_FAILED", summary: diagnostics.summary, diagnostics };
  }

  const contract = getOutputContract(contractName, options.contractOptions);
  const rawCandidates = collectWorkflowOutputCandidates(source);
  const evaluated = rawCandidates.map((candidate) => evaluateCandidate(candidate, contract));

  if (evaluated[0]?.valid && evaluated[0].value && typeof evaluated[0].value === "object") {
    return successResult(evaluated[0], evaluated);
  }

  const hasJson = evaluated.some((candidate) => candidate.syntax === "validJson" || candidate.syntax === "repairedJson");
  const errorCode: Exclude<OutputParseErrorCode, "OK"> = hasJson ? "OUTPUT_SCHEMA_FAILED" : "OUTPUT_PARSE_FAILED";
  const summary = rawCandidates.length === 0
    ? "Missing balanced JSON object."
    : hasJson
      ? `Last balanced JSON object did not satisfy the ${contractName} contract.`
      : "Last balanced JSON object could not be parsed as JSON.";
  const bestCandidate = evaluated[0];
  const diagnostics = createDiagnostics({
    errorCode,
    summary,
    candidates: evaluated,
    recoverability: "repairable",
    bestCandidateId: bestCandidate?.id
  });
  return { ok: false, errorCode, summary, diagnostics, bestCandidate };
}

export function collectWorkflowOutputCandidates(text: string): RawCandidate[] {
  const source = String(text ?? "");
  const span = extractLastBalancedJsonObject(source);
  if (!span) return [];
  return [{
    id: "candidate-1",
    mode: "lastBalancedJson",
    raw: span.raw,
    start: span.start,
    end: span.end
  }];
}

function evaluateCandidate(rawCandidate: RawCandidate, contract: ReturnType<typeof getOutputContract>): OutputCandidateDiagnostic {
  const base = {
    id: rawCandidate.id,
    mode: rawCandidate.mode,
    syntax: "invalidJson" as const,
    rawHash: hashText(rawCandidate.raw),
    rawPreview: preview(rawCandidate.raw),
    schemaErrors: [],
    aliasNormalizations: [],
    valid: false
  };

  const parsed = parseJsonWithRepair(rawCandidate.raw);
  if (!parsed.ok) {
    return {
      ...base,
      parseError: parsed.error,
      repairedPreview: parsed.repairedPreview
    };
  }

  const normalized = normalizeDeterministicAliases(parsed.value);
  const validation = contract.schema.safeParse(normalized.value);
  const schemaErrors = validation.success
    ? []
    : validation.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/",
        message: issue.message
      }));
  const selectedValue = validation.success ? validation.data : normalized.value;

  return {
    ...base,
    syntax: parsed.repaired ? "repairedJson" : "validJson",
    normalizedPreview: preview(JSON.stringify(selectedValue, null, 2)),
    repairedPreview: parsed.repairedText ? preview(parsed.repairedText) : undefined,
    schemaErrors,
    aliasNormalizations: normalized.normalizations,
    value: selectedValue,
    valid: validation.success
  };
}

function parseJsonWithRepair(raw: string): {
  ok: true;
  value: unknown;
  repaired: boolean;
  repairedText?: string;
} | {
  ok: false;
  error: string;
  repairedPreview?: string;
} {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown, repaired: false };
  } catch (error) {
    const firstError = error instanceof Error ? error.message : String(error);
    try {
      const repairedText = jsonrepair(raw);
      return { ok: true, value: JSON.parse(repairedText) as unknown, repaired: true, repairedText };
    } catch (repairError) {
      const secondError = repairError instanceof Error ? repairError.message : String(repairError);
      return { ok: false, error: `${firstError}; jsonrepair failed: ${secondError}` };
    }
  }
}

function successResult(candidate: OutputCandidateDiagnostic, evaluated: OutputCandidateDiagnostic[], warnings: string[] = []): OutputParseSuccess {
  const aliases = candidate.aliasNormalizations.map((entry) => `${entry.from}->${entry.to}`);
  return {
    ok: true,
    value: candidate.value as Record<string, unknown>,
    outputParse: {
      mode: candidate.mode,
      repaired: candidate.syntax === "repairedJson",
      candidateCount: evaluated.length,
      warnings,
      outputNormalizedAliases: aliases
    },
    diagnostics: createDiagnostics({
      errorCode: "OK",
      summary: "Workflow output parsed.",
      candidates: evaluated,
      recoverability: "not_repairable",
      bestCandidateId: candidate.id,
      warnings
    })
  };
}

function createDiagnostics(input: {
  errorCode: OutputParseErrorCode;
  summary: string;
  candidates: OutputCandidateDiagnostic[];
  recoverability: "repairable" | "not_repairable";
  bestCandidateId?: string;
  warnings?: string[];
}): OutputParseDiagnostics {
  return {
    errorCode: input.errorCode,
    summary: input.summary,
    candidateCount: input.candidates.length,
    bestCandidateId: input.bestCandidateId,
    recoverability: input.recoverability,
    candidates: input.candidates.map((candidate) => ({
      ...candidate,
      value: candidate.valid ? undefined : candidate.value
    })),
    warnings: input.warnings ?? []
  };
}

function extractLastBalancedJsonObject(text: string): { raw: string; start: number; end: number } | undefined {
  const spans = balancedObjectSpans(text);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    const raw = text.slice(span.start, span.end);
    const parsed = parseJsonWithRepair(raw);
    if (parsed.ok && isPlainObject(parsed.value)) return { raw, start: span.start, end: span.end };
  }
  return undefined;
}

function balancedObjectSpans(text: string): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      starts.push(index);
    } else if (char === "}") {
      const start = starts.pop();
      if (start !== undefined) spans.push({ start, end: index + 1 });
    }
  }
  return spans;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function preview(value: string, limit = PREVIEW_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... [truncated]` : value;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
