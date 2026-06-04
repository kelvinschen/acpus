import { z } from "zod";

export const SCHEMA_VERSION = "acpus.workflow/v1";

const IdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const VariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const WorkflowInputSchema = z.strictObject({
  schema: z.string().min(1),
  default: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional()
});

export const ActorModeSchema = z.enum(["denyAll", "readOnly", "edit"]);

export const ActorSchema = z.strictObject({
  agent: z.string().min(1),
  mode: ActorModeSchema,
  label: z.string().min(1).optional()
});

export const TransformSchema = z.strictObject({
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

export const VariableSchema = z.strictObject({
  name: VariableNameSchema,
  source: z.string().min(1),
  transform: z.array(TransformSchema).optional()
});

export const PositiveIntegerLimitSchema = z.number().int().positive();

export const LimitBindingSchema = z.strictObject({
  source: z.string().min(1),
  default: PositiveIntegerLimitSchema.optional()
});

export const LimitValueSchema = z.union([
  PositiveIntegerLimitSchema,
  LimitBindingSchema
]);

export const WorkflowLimitsSchema = z.strictObject({
  stageTimeoutMinutes: LimitValueSchema.optional()
});

export const StageLimitsSchema = z.strictObject({
  stageTimeoutMinutes: LimitValueSchema.optional()
});

export const FanoutStageLimitsSchema = z.strictObject({
  maxConcurrency: LimitValueSchema.optional(),
  maxFanoutItems: LimitValueSchema.optional(),
  stageTimeoutMinutes: LimitValueSchema.optional()
});

const OutputDeclarationSchema = z.strictObject({
  schema: z.string().min(1)
});

const StageBaseSchema = z.strictObject({
  id: IdentifierSchema,
  dependsOn: z.array(IdentifierSchema).optional(),
  variables: z.array(VariableSchema).optional(),
  limits: StageLimitsSchema.optional()
});

const SourceRefSchema = z.strictObject({
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
    z.strictObject({
      source: z.string().min(1),
      op: z.literal("in"),
      value: z.array(z.unknown())
    }),
    z.strictObject({
      source: z.string().min(1),
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
      value: z.unknown().optional()
    }),
    z.strictObject({
      source: z.string().min(1),
      op: z.enum(["exists", "empty"]),
      value: z.unknown().optional()
    }),
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema })
  ])
);

export const RouteRuleSchema = z.strictObject({
  when: ConditionSchema,
  to: IdentifierSchema
});

export const TaskAgentStageSchema = StageBaseSchema.extend({
  kind: z.literal("task"),
  mode: z.literal("agent"),
  actor: ActorSchema,
  prompt: z.string().min(1),
  output: OutputDeclarationSchema.optional()
});

export const TaskProgramStageSchema = StageBaseSchema.extend({
  kind: z.literal("task"),
  mode: z.literal("program"),
  operation: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  timeoutSeconds: z.number().int().positive().max(300).default(60),
  allowMutation: z.boolean().default(false)
});

export const TaskStageSchema = z.discriminatedUnion("mode", [
  TaskAgentStageSchema,
  TaskProgramStageSchema
]);

export const RouteProgramStageSchema = StageBaseSchema.extend({
  kind: z.literal("route"),
  mode: z.literal("program"),
  rules: z.array(RouteRuleSchema).min(1),
  routes: z.array(IdentifierSchema).min(1)
});

export const RouteAgentStageSchema = StageBaseSchema.extend({
  kind: z.literal("route"),
  mode: z.literal("agent"),
  rules: z.array(RouteRuleSchema).min(1),
  routes: z.array(IdentifierSchema).min(1),
  actor: ActorSchema,
  prompt: z.string().min(1)
});

export const RouteStageSchema = z.discriminatedUnion("mode", [
  RouteProgramStageSchema,
  RouteAgentStageSchema
]);

export const GateProgramStageSchema = StageBaseSchema.extend({
  kind: z.literal("gate"),
  mode: z.literal("program").default("program"),
  condition: ConditionSchema.optional()
});

export const GateAgentStageSchema = StageBaseSchema.extend({
  kind: z.literal("gate"),
  mode: z.literal("agent"),
  condition: ConditionSchema.optional(),
  actor: ActorSchema,
  prompt: z.string().min(1),
  output: OutputDeclarationSchema.optional()
});

export const GateStageSchema = z.union([
  GateAgentStageSchema,
  GateProgramStageSchema
]);

export const FanoutLaneSchema = z.strictObject({
  id: IdentifierSchema,
  actor: ActorSchema,
  prompt: z.string().min(1).optional(),
  when: ConditionSchema.optional(),
  output: OutputDeclarationSchema.optional()
});

export const FanoutPolicySchema = z.strictObject({
  allowPartial: z.boolean().default(false),
  minCompletedRatio: z.number().min(0).max(1).optional(),
  maxBlockedItems: z.number().int().nonnegative().optional()
});

export const AgentFaninSchema = z.strictObject({
  mode: z.literal("agent"),
  actor: ActorSchema,
  prompt: z.string().min(1),
  output: OutputDeclarationSchema.optional()
});

export const ProgramFaninSchema = z.strictObject({
  mode: z.literal("program"),
  operation: z.literal("mergeArrays")
});

export const FaninSchema = z.discriminatedUnion("mode", [
  AgentFaninSchema,
  ProgramFaninSchema
]);

export const FanoutStageSchema = StageBaseSchema.extend({
  kind: z.literal("fanout"),
  items: SourceRefSchema,
  limits: FanoutStageLimitsSchema.optional(),
  prompt: z.string().min(1).optional(),
  lanes: z.array(FanoutLaneSchema).min(1),
  fanin: FaninSchema,
  fanoutPolicy: FanoutPolicySchema.optional()
});

export type LoopBodyStage =
  | z.infer<typeof TaskStageSchema>
  | z.infer<typeof FanoutStageSchema>
  | z.infer<typeof RouteStageSchema>;

export const LoopBodyStageSchema: z.ZodType<LoopBodyStage> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    TaskStageSchema,
    FanoutStageSchema,
    RouteStageSchema
  ])
);

export const LoopStageSchema = StageBaseSchema.extend({
  kind: z.literal("loop"),
  maxRounds: z.number().int().positive(),
  body: z.strictObject({
    root: IdentifierSchema,
    output: IdentifierSchema,
    stages: z.array(LoopBodyStageSchema).min(1)
  }),
  continueWhen: ConditionSchema,
  onExhausted: z.literal("blocked")
});

export const StageSchema = z.union([
  TaskStageSchema,
  FanoutStageSchema,
  LoopStageSchema,
  RouteStageSchema,
  GateStageSchema
]);

export const WorkflowSpecSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().min(1),
  description: z.string().default(""),
  root: IdentifierSchema,
  input: WorkflowInputSchema.optional(),
  limits: WorkflowLimitsSchema.default({}),
  stages: z.array(StageSchema).min(1)
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type Variable = z.infer<typeof VariableSchema>;
export type ConditionNode = z.infer<typeof ConditionSchema>;
