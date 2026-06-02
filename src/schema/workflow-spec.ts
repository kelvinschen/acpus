import { z } from "zod";

export const SCHEMA_VERSION = "acpx-workflow-orchestrator.workflow/v1";

const IdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const VariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const InputTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "path",
  "glob",
  "json",
  "array<string>",
  "array<path>",
  "array<json>"
]);

export const InputDeclarationSchema = z.object({
  type: InputTypeSchema,
  default: z.unknown().optional(),
  description: z.string().optional()
});

export const RoleCategorySchema = z.enum([
  "planning",
  "implementation",
  "validation",
  "review",
  "research",
  "summarization",
  "coordination"
]);

export const RoleModeSchema = z.enum(["denyAll", "readOnly", "edit"]);

export const RoleSchema = z.object({
  category: RoleCategorySchema,
  agent: z.string().min(1),
  mode: RoleModeSchema
});

export const TransformSchema = z.object({
  fn: z.enum([
    "compact",
    "tail",
    "json",
    "quoteBlock",
    "pathList",
    "filterSeverity",
    "severitySummary",
    "join",
    "default"
  ]),
  args: z.record(z.string(), z.unknown()).optional()
});

export const VariableSchema = z.object({
  name: VariableNameSchema,
  source: z.string().min(1),
  transform: z.array(TransformSchema).optional()
});

export const WorkflowLimitsSchema = z.strictObject({
  stageTimeoutMinutes: z.number().int().positive().optional()
});

export const StageLimitsSchema = z.strictObject({
  maxConcurrency: z.number().int().positive().optional(),
  maxFanoutItems: z.number().int().positive().optional(),
  stageTimeoutMinutes: z.number().int().positive().optional()
});

export const ArtifactSchema = z.object({
  kind: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional()
});

export const SeverityCountsSchema = z.object({
  P0: z.number().int().nonnegative(),
  P1: z.number().int().nonnegative(),
  P2: z.number().int().nonnegative(),
  P3: z.number().int().nonnegative()
});

export const FindingSchema = z.object({
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  summary: z.string(),
  path: z.string().optional(),
  details: z.string().optional()
});

export const CheckSchema = z.object({
  command: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(["pass", "fail", "skipped", "unknown"]),
  summary: z.string().optional()
});

export const BaseOutputSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string(),
  artifacts: z.array(ArtifactSchema).default([]),
  nextFocus: z.string().default(""),
  data: z.record(z.string(), z.unknown()).optional()
});

export const ValidationOutputSchema = BaseOutputSchema.extend({
  verdict: z.enum(["pass", "fix", "blocked", "unknown"]),
  severityCounts: SeverityCountsSchema,
  findings: z.array(FindingSchema).default([]),
  checks: z.array(CheckSchema).default([])
});

export const ImplementationOutputSchema = BaseOutputSchema.extend({
  changedFiles: z.array(z.string()).default([]),
  checks: z.array(CheckSchema).default([])
});

export const GateOutputSchema = BaseOutputSchema.extend({
  verdict: z.enum(["pass", "pass_with_warnings", "blocked", "failed", "unknown"]),
  deliverables: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  checks: z.array(CheckSchema).default([]),
  warnings: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([])
});

const StageBaseSchema = z.object({
  id: IdentifierSchema,
  dependsOn: z.array(IdentifierSchema).optional(),
  variables: z.array(VariableSchema).optional(),
  prompt: z.string().optional(),
  limits: StageLimitsSchema.optional()
});

const SourceRefSchema = z.object({
  source: z.string().min(1)
});

type Condition = {
  source?: string;
  op?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "exists" | "empty";
  value?: unknown;
  all?: Condition[];
  any?: Condition[];
  not?: Condition;
};

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      source: z.string().min(1),
      op: z.literal("in"),
      value: z.array(z.unknown())
    }),
    z.object({
      source: z.string().min(1),
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
      value: z.unknown().optional()
    }),
    z.object({
      source: z.string().min(1),
      op: z.enum(["exists", "empty"]),
      value: z.unknown().optional()
    }),
    z.object({ all: z.array(ConditionSchema).min(1) }),
    z.object({ any: z.array(ConditionSchema).min(1) }),
    z.object({ not: ConditionSchema })
  ])
);

export const DecisionRuleSchema = z.object({
  when: ConditionSchema,
  to: z.string().min(1)
});

export const FanoutLaneSchema = z.object({
  id: IdentifierSchema,
  role: IdentifierSchema,
  prompt: z.string().min(1).optional(),
  when: ConditionSchema.optional(),
  default: z.boolean().optional()
});

export const FanoutLaneGroupSchema = z.object({
  id: IdentifierSchema,
  mode: z.enum(["all", "oneOf"]),
  lanes: z.array(FanoutLaneSchema).min(1)
});

export const AgentTaskStageSchema = StageBaseSchema.extend({
  kind: z.literal("agentTask"),
  role: IdentifierSchema,
  prompt: z.string().min(1)
});

export const DiscoverStageSchema = StageBaseSchema.extend({
  kind: z.literal("discover"),
  method: z.enum(["gitChangedFiles", "glob", "agent"]),
  args: z.record(z.string(), z.unknown()).optional(),
  output: z.string().default("items"),
  role: IdentifierSchema.optional(),
  prompt: z.string().optional()
});

export const FanoutStageSchema = StageBaseSchema.extend({
  kind: z.literal("fanout"),
  items: SourceRefSchema,
  prompt: z.string().min(1).optional(),
  laneGroups: z.array(FanoutLaneGroupSchema).min(1),
  fanoutPolicy: z.object({
    allowPartial: z.boolean().default(false),
    minCompletedRatio: z.number().min(0).max(1).optional(),
    maxBlockedItems: z.number().int().nonnegative().optional()
  }).optional()
});

export const ReduceStageSchema = StageBaseSchema.extend({
  kind: z.literal("reduce"),
  mode: z.enum(["agent", "program"]).default("agent"),
  from: IdentifierSchema,
  role: IdentifierSchema.optional(),
  prompt: z.string().optional(),
  operation: z.enum(["mergeArrays", "severitySummary", "dedupeFindings", "sortBySeverity"]).optional()
});

export const FixLoopStageSchema = StageBaseSchema.extend({
  kind: z.literal("fixLoop"),
  maxRounds: z.number().int().positive(),
  validator: z.object({
    role: IdentifierSchema,
    prompt: z.string().min(1),
    variables: z.array(VariableSchema).optional()
  }),
  fixer: z.object({
    role: IdentifierSchema,
    prompt: z.string().min(1),
    variables: z.array(VariableSchema).optional()
  }),
  routingPolicy: z.object({
    fixOn: z.array(z.string()).default(["P0", "P1", "failedRequiredCheck"]),
    ignoreForRouting: z.array(z.string()).default(["P2", "P3"]),
    unknown: z.literal("blocked")
  }),
  onUnknown: z.literal("blocked"),
  onExhausted: z.literal("blocked")
});

export const DecisionGateStageSchema = StageBaseSchema.extend({
  kind: z.literal("decisionGate"),
  mode: z.enum(["program", "agent"]).default("program"),
  rules: z.array(DecisionRuleSchema).min(1),
  default: z.string().min(1),
  role: IdentifierSchema.optional(),
  prompt: z.string().optional(),
  routes: z.array(z.string()).optional()
});

export const GateStageSchema = StageBaseSchema.extend({
  kind: z.literal("gate"),
  mode: z.enum(["program", "agent"]).default("program"),
  condition: ConditionSchema.optional(),
  role: IdentifierSchema.optional(),
  prompt: z.string().optional()
});

export const SummarizeStageSchema = StageBaseSchema.extend({
  kind: z.literal("summarize"),
  role: z.literal("summarizer"),
  prompt: z.string().min(1)
});

export const StageSchema = z.discriminatedUnion("kind", [
  AgentTaskStageSchema,
  DiscoverStageSchema,
  FanoutStageSchema,
  ReduceStageSchema,
  FixLoopStageSchema,
  DecisionGateStageSchema,
  GateStageSchema,
  SummarizeStageSchema
]);

export const WorkflowSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().min(1),
  description: z.string().default(""),
  root: IdentifierSchema,
  inputs: z.record(z.string(), InputDeclarationSchema).default({}),
  roles: z.record(z.string(), RoleSchema),
  limits: WorkflowLimitsSchema.default({}),
  stages: z.array(StageSchema).min(1)
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Variable = z.infer<typeof VariableSchema>;
export type ConditionNode = z.infer<typeof ConditionSchema>;
