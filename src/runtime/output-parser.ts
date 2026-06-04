import crypto from "node:crypto";
import { defaultAgentOutputZod, zodForCompiledSchema, type CompiledSchema } from "../contracts/schema-dsl.js";
import type { z } from "zod";

export type OutputParseErrorCode =
  | "OK"
  | "OUTPUT_PARSE_FAILED"
  | "OUTPUT_SCHEMA_FAILED";

export type OutputCandidateMode = "lastBalancedJsonObject";

export type OutputCandidateSyntax = "invalidJson" | "validJson";

export type OutputCandidateDiagnostic = {
  id: string;
  mode: OutputCandidateMode;
  syntax: OutputCandidateSyntax;
  rawHash: string;
  rawPreview: string;
  normalizedPreview?: string;
  parseError?: string;
  schemaErrors: Array<{ path: string; message: string }>;
  valid: boolean;
  value?: unknown;
};

export type OutputParseDiagnostics = {
  errorCode: OutputParseErrorCode;
  summary: string;
  candidateCount: number;
  bestCandidateId?: string;
  recoverability: "retryable" | "not_retryable";
  candidates: OutputCandidateDiagnostic[];
};

export type OutputParseSuccess = {
  ok: true;
  value: Record<string, unknown>;
  outputParse: {
    mode: OutputCandidateMode;
    candidateCount: number;
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
  outputSchema?: CompiledSchema;
  implicitFields?: Record<string, z.ZodType>;
};

type RawCandidate = {
  id: string;
  mode: OutputCandidateMode;
  raw: string;
  start: number;
  end: number;
};

const PREVIEW_CHARS = 2000;

export function parseWorkflowOutput(text: string, options: ParseWorkflowOutputOptions = {}): OutputParseResult {
  const source = String(text ?? "");
  const outputSchema = options.outputSchema
    ? { schema: zodForCompiledSchema(options.outputSchema, options.implicitFields) }
    : { schema: defaultAgentOutputZod(options.implicitFields) };
  const rawCandidates = collectWorkflowOutputCandidates(source);
  const evaluated = rawCandidates.map((candidate) => evaluateCandidate(candidate, outputSchema));

  if (evaluated[0]?.valid && evaluated[0].value && typeof evaluated[0].value === "object" && !Array.isArray(evaluated[0].value)) {
    return successResult(evaluated[0], evaluated);
  }

  const hasJson = evaluated.some((candidate) => candidate.syntax === "validJson");
  const errorCode: Exclude<OutputParseErrorCode, "OK"> = hasJson ? "OUTPUT_SCHEMA_FAILED" : "OUTPUT_PARSE_FAILED";
  const summary = rawCandidates.length === 0
    ? "Missing JSON response."
    : hasJson
      ? "JSON response did not satisfy the workflow output schema."
      : "Response could not be parsed as JSON.";
  const bestCandidate = evaluated[0];
  const diagnostics = createDiagnostics({
    errorCode,
    summary,
    candidates: evaluated,
    recoverability: "retryable",
    bestCandidateId: bestCandidate?.id
  });
  return { ok: false, errorCode, summary, diagnostics, bestCandidate };
}

export function collectWorkflowOutputCandidates(text: string): RawCandidate[] {
  const source = String(text ?? "");
  const candidate = findLastBalancedObject(source);
  if (!candidate) return [];
  return [{
    id: "candidate-1",
    mode: "lastBalancedJsonObject",
    raw: source.slice(candidate.start, candidate.end),
    start: candidate.start,
    end: candidate.end
  }];
}

function findLastBalancedObject(source: string): { start: number; end: number } | undefined {
  const stack: Array<{ char: "{" | "["; index: number }> = [];
  let inString = false;
  let escaped = false;
  let last: { start: number; end: number } | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push({ char, index });
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const open = stack.at(-1);
    if (!open) continue;
    if (char === "}" && open.char !== "{") {
      stack.length = 0;
      continue;
    }
    if (char === "]" && open.char !== "[") {
      stack.length = 0;
      continue;
    }
    stack.pop();
    if (char === "}" && !stack.some((entry) => entry.char === "[")) {
      last = { start: open.index, end: index + 1 };
    }
  }

  return last;
}

function evaluateCandidate(rawCandidate: RawCandidate, outputSchema: { schema: z.ZodType }): OutputCandidateDiagnostic {
  const base = {
    id: rawCandidate.id,
    mode: rawCandidate.mode,
    syntax: "invalidJson" as const,
    rawHash: hashText(rawCandidate.raw),
    rawPreview: preview(rawCandidate.raw),
    schemaErrors: [],
    valid: false
  };

  const parsed = parseJson(rawCandidate.raw);
  if (!parsed.ok) {
    return {
      ...base,
      parseError: parsed.error,
    };
  }

  const validation = outputSchema.schema.safeParse(parsed.value);
  const schemaErrors = validation.success
    ? []
    : validation.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/",
        message: issue.message
      }));
  const selectedValue = validation.success ? validation.data : parsed.value;

  return {
    ...base,
    syntax: "validJson",
    normalizedPreview: preview(JSON.stringify(selectedValue, null, 2)),
    schemaErrors,
    value: selectedValue,
    valid: validation.success
  };
}

function parseJson(raw: string): {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: string;
} {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function successResult(candidate: OutputCandidateDiagnostic, evaluated: OutputCandidateDiagnostic[]): OutputParseSuccess {
  return {
    ok: true,
    value: candidate.value as Record<string, unknown>,
    outputParse: {
      mode: candidate.mode,
      candidateCount: evaluated.length
    },
    diagnostics: createDiagnostics({
      errorCode: "OK",
      summary: "Workflow output parsed.",
      candidates: evaluated,
      recoverability: "not_retryable",
      bestCandidateId: candidate.id
    })
  };
}

function createDiagnostics(input: {
  errorCode: OutputParseErrorCode;
  summary: string;
  candidates: OutputCandidateDiagnostic[];
  recoverability: "retryable" | "not_retryable";
  bestCandidateId?: string;
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
    }))
  };
}

function preview(value: string, limit = PREVIEW_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... [truncated]` : value;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
