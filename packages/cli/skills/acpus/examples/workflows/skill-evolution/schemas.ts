import { z } from "acpus/core";

export const DiscoveryModeSchema = z.enum(["agents", "claude"]);
export const TrialPhaseSchema = z.enum(["dev", "holdout"]);
export const TrialVariantSchema = z.enum(["candidate", "parent", "no-skill"]);
export const TriggerExpectationSchema = z.enum([
  "must-trigger",
  "should-trigger",
  "should-not-trigger",
  "not-scored",
]);

export const CapabilitySchema = z.object({
  id: z.string(),
  description: z.string(),
  importance: z.enum(["core", "supporting"]),
  evidence: z.array(z.string()),
});

export const RubricSchema = z.object({
  id: z.string(),
  category: z.enum([
    "outcome",
    "process",
    "quality",
    "robustness",
    "trigger",
    "efficiency",
    "safety",
    "hygiene",
  ]),
  criterion: z.string(),
  weight: z.number(),
  hardGate: z.boolean(),
  grader: z.enum(["deterministic", "llm", "human"]),
  scale: z.enum(["binary", "0-2", "0-4"]),
});

export const FixtureSpecSchema = z.object({
  kind: z.enum(["inline-text", "copy"]),
  path: z.string(),
  content: z.string().optional(),
  source: z.string().optional(),
});

export const GraderCheckSchema = z.object({
  id: z.string(),
  rubricId: z.string(),
  kind: z.enum([
    "file-exists",
    "file-not-exists",
    "glob-count",
    "json-valid",
    "text-regex",
    "git-diff-allowlist",
    "trace-tool-used",
    "trace-command-match",
    "max-tool-calls",
    "max-provider-turns",
    "max-total-tokens",
    "registered-command",
  ]),
  hardGate: z.boolean(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  value: z.number().optional(),
  allow: z.array(z.string()).optional(),
  commandId: z.string().optional(),
});

export const BenchmarkCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  expectedOutcome: z.string(),
  capabilityIds: z.array(z.string()),
  rubricIds: z.array(z.string()),
  tags: z.array(z.string()),
  triggerExpectation: TriggerExpectationSchema,
  fixtures: z.array(FixtureSpecSchema),
  deterministicChecks: z.array(GraderCheckSchema),
  allowedWriteGlobs: z.array(z.string()),
  suggestedSplit: z.enum(["dev", "holdout"]),
  sentinel: z.boolean(),
});

export const BenchmarkDesignSchema = z.object({
  capabilityContract: z.array(CapabilitySchema),
  normalizedRubrics: z.array(RubricSchema),
  candidateCases: z.array(BenchmarkCaseSchema),
  designDecisions: z.array(z.string()),
  rejectedCases: z.array(z.object({
    name: z.string(),
    reason: z.string(),
  })),
});

export const JudgeRubricResultSchema = z.object({
  rubricId: z.string(),
  score: z.number().nullable(),
  passed: z.boolean().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceRefs: z.array(z.string()),
  explanation: z.string(),
});

export const BatchJudgmentSchema = z.object({
  trials: z.array(z.object({
    trialId: z.string(),
    rubricResults: z.array(JudgeRubricResultSchema),
  })),
  comparisons: z.array(z.object({
    caseId: z.string(),
    winner: z.enum(["A", "B", "tie", "unknown"]),
    reasons: z.array(z.string()),
  })),
});

export const PatchChangeSchema = z.object({
  path: z.string(),
  operation: z.enum(["create", "replace", "delete"]),
  content: z.string().optional(),
  executable: z.boolean().optional(),
});

export const PatchProposalSchema = z.object({
  action: z.enum(["patch", "stop", "needs-human"]),
  summary: z.string(),
  baseSha256: z.string(),
  hypotheses: z.array(z.object({
    id: z.string(),
    rootCause: z.string(),
    evidenceRefs: z.array(z.string()),
    affectedRubricIds: z.array(z.string()),
    proposedChange: z.string(),
  })),
  rejectedAlternatives: z.array(z.object({
    proposal: z.string(),
    reason: z.string(),
  })),
  changes: z.array(PatchChangeSchema),
  expectedImpact: z.array(z.object({
    rubricId: z.string(),
    direction: z.enum(["improve", "neutral", "risk"]),
    reason: z.string(),
  })),
  risks: z.array(z.object({
    kind: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    mitigation: z.string(),
  })),
});

export const ApprovalSchema = z.object({
  approved: z.boolean(),
  notes: z.string(),
});

export type DiscoveryMode = z.infer<typeof DiscoveryModeSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type Rubric = z.infer<typeof RubricSchema>;
export type FixtureSpec = z.infer<typeof FixtureSpecSchema>;
export type GraderCheck = z.infer<typeof GraderCheckSchema>;
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;
export type BenchmarkDesign = z.infer<typeof BenchmarkDesignSchema>;
export type BatchJudgment = z.infer<typeof BatchJudgmentSchema>;
export type PatchChange = z.infer<typeof PatchChangeSchema>;
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export type TrialPhase = "dev" | "holdout";
export type TrialVariant = "candidate" | "parent" | "no-skill";

export type TrialPlan = {
  trialId: string;
  phase: TrialPhase;
  iteration: number;
  case: BenchmarkCase;
  variant: TrialVariant;
  version: string | null;
  skillDir: string | null;
  blindLabel: "A" | "B" | null;
};

export type ActivationEvidence = {
  status: "confirmed" | "inferred" | "unavailable";
  method: "skill-tool-call" | "skill-file-read" | "trace-match" | "none";
  evidenceRefs: string[];
  reason: string;
};

export type TrialRecord = {
  trialId: string;
  caseId: string;
  phase: TrialPhase;
  iteration: number;
  variant: TrialVariant;
  version: string | null;
  blindLabel: "A" | "B" | null;
  childRunId: string | null;
  status: "completed" | "failed" | "canceled" | "timed-out" | "unknown";
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  workspaceDir: string;
  homeDir: string;
  recordPath: string;
  inspectPath: string;
  artifactsPath: string;
  outputManifestPath: string;
  traceSummaryPath: string;
  turnArtifactPaths: string[];
  traceArtifactPaths: string[];
  providerTurns: number;
  toolCalls: number;
  totalTokens: number | null;
  activation: ActivationEvidence;
  changedPaths: string[];
  failure: {
    origin: string;
    code: string;
    message: string;
  } | null;
};

export type CheckResult = {
  id: string;
  rubricId: string;
  kind: GraderCheck["kind"];
  passed: boolean | null;
  score: number | null;
  hardGate: boolean;
  evidenceRefs: string[];
  explanation: string;
};

export type TrialGrade = {
  trialId: string;
  caseId: string;
  variant: TrialVariant;
  version: string | null;
  status: TrialRecord["status"];
  checks: CheckResult[];
  hardGateFailures: string[];
  deterministicScore: number | null;
};
