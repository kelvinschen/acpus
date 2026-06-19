export { DiagnosticBag } from "./diagnostics.js";
export { compileWorkflow, lintWorkflow } from "./compiler.js";
export {
  applyAgentOverrides,
  emptyAgentOverrideResult,
  optionalSubmissionMetadata,
  parseAgentOverridesInput,
  parseWorkflowSpecForOverrides,
  serializeWorkflowSpecForOverrides,
  validateAgentOverrides
} from "./agent-overrides.js";
export { createSchedule } from "./schedule.js";
export { createIncludeResolver, globalWorkflowRoot, realPathOrUndefined, workflowSourceResolver } from "./source-resolver.js";
export { compileSchemaDsl } from "./schema/index.js";
export type { CompileSchemaDslResult, SchemaDslError, CompileSchemaDslOptions } from "./schema/index.js";
export type { WorkflowSourceResolver } from "./source-resolver.js";
export {
  EXPRESSION_PATTERN,
  ALLOWED_ROOTS,
  ALLOWED_FUNCTIONS,
  toCelParseSource,
  createExpressionCollector
} from "./expressions.js";
export type { ExpressionCollector } from "./expressions.js";
export { extractReferences, referenceToString, isStaticReference } from "./cel-ast.js";
export type { ExpressionReference, ReferenceSegment, ExtractResult } from "./cel-ast.js";
export { validateScopedExpressions } from "./expression-scope.js";
export type { ScopedValidationInput } from "./expression-scope.js";
export { COMPOSITE_CONTRACTS, outputMergeFor, keyTemplateForKind } from "./composite-contract.js";
export type { CompositeContract, OutputShapeKind } from "./composite-contract.js";
export { parseDurationMs } from "./duration.js";
export type { ParseDurationOptions } from "./duration.js";
export { INJECTOR_NAMES, EVENT_NAMES } from "./hooks.js";
export { validateHookConfigShape } from "./hook-validation.js";
export type { HookValidationIssue } from "./hook-validation.js";
export type {
  InjectorName,
  EventName,
  HookOnFailure,
  HookHandlerBase,
  InjectorHookHandler,
  EventHookHandler,
  HookHandler,
  HookConfig,
  HookConfigSnapshot,
  HookPayload,
  HookAgentTelemetry,
  AgentInjectorResult,
  ProgramInjectorResult,
  InjectorResult,
  HookJournalEntry
} from "./hooks.js";
export { hashIrNode } from "./hash.js";
export type {
  AcpusIr,
  AgentOverrideWarning,
  AgentOverrides,
  AgentSpec,
  CompileOptions,
  CompileResult,
  Diagnostic,
  DiagnosticSeverity,
  IrBranch,
  IrExpression,
  IrNode,
  IrNodeKind,
  LintResult,
  NodeKeyTemplate,
  OutputMerge,
  ScheduleNode,
  ScheduleSummary,
  WorkflowSpec,
  WorkflowStep
} from "./types.js";
