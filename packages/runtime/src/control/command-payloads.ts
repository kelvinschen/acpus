import { z, type Schema } from "@acpus/core/schema";
import type { JsonValue } from "@acpus/expression/ir";
import type { SchedulerStoreError } from "../scheduler/store-port.js";
import type {
  AgentOverrideMap,
  AppliedCommandPayload,
  CancelCommandPayload,
  CommandPayload,
  ControlCommandStatus,
  ControlCommandType,
  EmptyCommandPayload,
  FailedCommandPayload,
  ForkCommandPayload,
  PauseCommandPayload,
  RetryCommandPayload,
  SignalCommandPayload,
} from "../store/store.js";

const JsonValueSchema: Schema<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

const AgentOverrideSchema = z.object({
  use: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  model: z.string().optional(),
  permissionMode: z.enum(["approve-reads", "approve-all", "deny-all"]).optional(),
  agentMode: z.string().min(1).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict().refine(value => value.use === undefined || value.command === undefined, {
  message: "must not specify both use and command",
});

const AgentOverrideMapSchema = z.record(z.string(), AgentOverrideSchema);

const ForkPreparedWorkflowSchema = z.object({
  workflowPath: z.string(),
  irJson: z.string(),
  irDigest: z.string(),
  sourceGraphDigest: z.string(),
  packageLockDigest: z.string().optional(),
  lock: z.object({
    kind: z.literal("acpus_preflight_lock"),
    version: z.literal(1),
    workflow: z.object({
      entry: z.string(),
      sourceDigest: z.string().optional(),
    }).strict(),
    ir: z.object({
      path: z.literal("workflow.ir.json"),
      digest: z.string(),
    }).strict(),
    packageLockDigest: z.string().optional(),
    sourceGraphDigest: z.string(),
    generatedAt: z.string(),
  }).strict(),
}).strict();

const PauseCommandPayloadSchema = z.object({ reason: z.string().optional() }).strict();
const EmptyCommandPayloadSchema = z.object({}).strict();
const TargetPayloadSchema = z.object({ target: z.string().optional() }).strict();
const ForkCommandPayloadSchema = z.object({
  prepared: ForkPreparedWorkflowSchema.optional(),
  input: JsonValueSchema.optional(),
  agentOverrides: AgentOverrideMapSchema.optional(),
  target: z.string().min(1).optional(),
  unsafeReuse: z.boolean().optional(),
}).strict();
const SignalCommandPayloadSchema = z.object({
  node: z.string().min(1),
  payload: JsonValueSchema.optional(),
}).strict();
const AppliedCommandPayloadSchema = z.object({
  status: z.string(),
  forkRunId: z.string().optional(),
  target: z.string().optional(),
  targetKey: z.string().optional(),
}).strict();

const UnhandledFailedCommandPayloadSchema = z.object({
  type: z.literal("unhandled-error"),
  message: z.string(),
}).strict();
const TargetFailedCommandPayloadSchema = z.object({
  type: z.union([z.literal("target-resolution-failure"), z.literal("dynamic-target-ambiguity")]),
  target: z.string(),
  message: z.string(),
}).strict();
const ArtifactFailedCommandPayloadSchema = z.object({
  type: z.literal("artifact-rewrite-failure"),
  artifactId: z.string(),
  message: z.string(),
}).strict();
const SchedulerFailedCommandPayloadSchema = z.object({
  type: z.enum([
    "run-not-found",
    "version-mismatch",
    "owner-epoch-inactive",
    "owner-epoch-still-active",
    "run-paused",
    "terminal-attempt",
    "attempt-not-found",
    "owner-epoch-stale",
    "signal-wait-not-found",
    "signal-wait-terminal",
    "idempotency-conflict",
    "missing-retry-target",
    "invalid-retry-target",
    "missing-cancel-target",
    "invalid-cancel-target",
    "invalid-control-state",
  ] satisfies [SchedulerStoreError["type"], ...SchedulerStoreError["type"][]]),
  message: z.string(),
}).strict();
export function parseAgentOverrideMap(value: unknown, irAgents?: Record<string, unknown>): AgentOverrideMap {
  if (!isPlainRecord(value)) throw new Error("Agent overrides must be a JSON object keyed by declared agent name.");
  const legacyKey = Object.entries(value).find(([, override]) => isPlainRecord(override) && ("options" in override || "policy" in override || "kind" in override));
  if (legacyKey) {
    const [name, override] = legacyKey;
    if (isPlainRecord(override) && "options" in override) throw new Error(`Agent override '${name}' must not use options.`);
    if (isPlainRecord(override) && "policy" in override) throw new Error(`Agent override '${name}' must use permissionMode, not policy.`);
    throw new Error(`Agent override '${name}' must not include kind.`);
  }
  if (irAgents) {
    const unknownAgent = Object.keys(value).find(name => !irAgents[name]);
    if (unknownAgent) throw new Error(`Agent override '${unknownAgent}' does not reference a declared agent.`);
  }
  return parseSchema("Agent overrides", AgentOverrideMapSchema, value) as AgentOverrideMap;
}

export function parseCommandPayload(type: ControlCommandType, status: ControlCommandStatus, value: JsonValue): CommandPayload<ControlCommandType> | AppliedCommandPayload | FailedCommandPayload {
  if (status === "applied") return parseSchema("Applied command payload", AppliedCommandPayloadSchema, value) as AppliedCommandPayload;
  if (status === "failed") return parseFailedCommandPayload(value);
  switch (type) {
    case "pause": return parseSchema("Pause command payload", PauseCommandPayloadSchema, value) as PauseCommandPayload;
    case "resume": return parseSchema("Resume command payload", EmptyCommandPayloadSchema, value) as EmptyCommandPayload;
    case "retry": return parseSchema("Retry command payload", TargetPayloadSchema, value) as RetryCommandPayload;
    case "cancel": return parseSchema("Cancel command payload", TargetPayloadSchema, value) as CancelCommandPayload;
    case "fork": return parseSchema("Fork command payload", ForkCommandPayloadSchema, value) as ForkCommandPayload;
    case "signal": return parseSchema("Signal command payload", SignalCommandPayloadSchema, value) as SignalCommandPayload;
    case "shutdown": return parseSchema("Shutdown command payload", EmptyCommandPayloadSchema, value) as EmptyCommandPayload;
  }
}

function parseFailedCommandPayload(value: unknown): FailedCommandPayload {
  if (!isPlainRecord(value)) throw new Error("Failed command payload must be a JSON object.");
  if (value.type === "unhandled-error") return parseSchema("Failed command payload", UnhandledFailedCommandPayloadSchema, value) as FailedCommandPayload;
  if (value.type === "target-resolution-failure" || value.type === "dynamic-target-ambiguity") return parseSchema("Failed command payload", TargetFailedCommandPayloadSchema, value) as FailedCommandPayload;
  if (value.type === "artifact-rewrite-failure") return parseSchema("Failed command payload", ArtifactFailedCommandPayloadSchema, value) as FailedCommandPayload;
  if (typeof value.type === "string" && SchedulerFailedCommandPayloadSchema.shape.type.safeParse(value.type).success) return parseSchema("Failed command payload", SchedulerFailedCommandPayloadSchema, value) as FailedCommandPayload;
  throw new Error(`Failed command payload is invalid: $.type Unsupported value '${String(value.type)}'`);
}

export function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function parseSchema<T>(label: string, schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`${label} is invalid: ${result.error.issues.map(formatIssue).join("; ")}`);
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
  return `${path} ${issue.message}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
