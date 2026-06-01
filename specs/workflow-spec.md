# Workflow Specification

## Status

- Current implementation: current
- Source modules: `src/schema/workflow-spec.ts`, `src/schema/input-validation.ts`, `src/schema/load.ts`, `src/compiler/compile.ts`, `src/compiler/lint.ts`, `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`, `schemas/workflow-spec.schema.json`, `workflows/examples/*.workflow.spec.json`
- Maintenance trigger: update this spec when changing workflow schema, validation, linting, compilation, execution-plan shape, stage kinds, variable semantics, limits, or example workflow contracts

## Purpose

`workflow.spec.json` is the stable, hand-editable authoring interface for the ACPX workflow orchestrator. The compiler validates it, lints graph semantics, and compiles it into `execution-plan.json` for the runtime scheduler.

## Normative Requirements

- Workflow specs MUST use schema version `acpx-workflow-orchestrator.workflow/v1`.
- A workflow spec MUST explicitly name `root`.
- A workflow graph MUST have exactly one dependency-free root stage, and `root` MUST name that stage.
- A workflow graph MUST have exactly one `gate` stage.
- The `gate` stage MUST be terminal and MUST be the only terminal workflow stage.
- `summarize` stages are deprecated authoring input and MUST be rejected by lint with migration guidance.
- Program `gate` stages MUST use `mode: "program"` by default and MAY declare `condition` using the condition DSL.
- A program `gate` without `condition` MUST have exactly one upstream dependency and MUST pass when `outputs.<upstream>` exists.
- Agent `gate` stages MUST declare a role and prompt, and the role MUST NOT use edit mode.
- Terminal `gate` dependencies MAY treat skipped upstream decision branches as satisfied.
- Stage dependencies MUST be expressed with explicit `dependsOn` fields.
- Workflow specs MUST NOT use global `edges`.
- Workflow graphs MUST NOT contain arbitrary cycles; bounded retry behavior MUST use the supported `fixLoop` model.
- Route branching MUST be expressed with `decisionGate`.
- File or glob discovery MUST be expressed as an explicit `discover` stage.
- Agent discovery MUST declare an explicit role and prompt.
- `fanout` MUST schedule one independent runtime item per selected item while respecting the fanout stage `limits.maxConcurrency` value.
- Fanout items MUST use deterministic item session keys.
- Fanout item outputs MUST be aggregated by the orchestrator before downstream stages run.
- `fixLoop` MUST be the only supported workflow-level bounded retry stage kind.
- `fixLoop` MUST declare `maxRounds`, `validator`, `fixer`, `routingPolicy`, `onUnknown`, and `onExhausted`.
- `fixLoop` validator roles MUST NOT use edit mode.
- `fixLoop` fixer roles MUST use edit mode.
- `fixLoop` routing policy MUST declare severities or check outcomes that trigger a fix turn, severities ignored for routing, and `unknown: "blocked"`.
- Edit fanout MAY be used, but it MUST be followed by a read-only reconcile or reduce stage.
- Prompt placeholders MUST use `${variableName}` syntax only.
- Variables MUST declare a `source` and MAY declare fixed built-in transforms.
- Input defaults and runtime `--input-json` values MUST be checked against lightweight input type declarations.
- The compiler MUST reject undeclared variables and unsafe graph shapes with JSON Pointer errors.
- The generated JSON Schema MUST match Zod default semantics: properties with schema defaults MUST NOT be required by the JSON Schema.
- Top-level `limits` MUST NOT include agent call budgets, concurrency limits, fanout item caps, or fix-loop round caps.
- Fanout stage `limits.maxConcurrency` MUST default to `1` when omitted.
- Fanout stage `limits.maxFanoutItems` MUST default to `1` when omitted.
- Stage `limits.maxConcurrency` and `limits.maxFanoutItems` MUST be accepted only on `fanout` stages.
- `limits.stageTimeoutMinutes` MAY bound stage runtime duration where enforced by runtime execution.
- `limits.maxOutputChars` MAY bound report/projection output size and diagnostics.
- Stage `limits.stageTimeoutMinutes` MAY override the workflow timeout, but MUST NOT exceed top-level `limits.stageTimeoutMinutes` when the top-level value is declared.

## Interfaces and Contracts

The canonical minimal shape is:

```json
{
  "schemaVersion": "acpx-workflow-orchestrator.workflow/v1",
  "root": "plan"
}
```

Authoring examples live under `workflows/examples/*.workflow.spec.json`. The generated JSON schema lives at `schemas/workflow-spec.schema.json`.

Stage output contracts are inferred from role category:

- planning, research, and coordination roles use the base output contract unless selected by a more specific stage kind;
- implementation roles produce changed files and checks;
- validation and review roles produce verdicts, severity counts, findings, and checks;
- gate produces `verdict`, deliverables, changed files, checks, warnings, risks, and next actions.

## Data Model

A workflow spec contains schema metadata, optional typed inputs, roles, limits, stages, explicit dependencies, variables, and stage-specific configuration. Role categories are `planning`, `implementation`, `validation`, `review`, `research`, `summarization`, and `coordination`. Role modes are `denyAll`, `readOnly`, and `edit`.

Top-level limits include `stageTimeoutMinutes` and `maxOutputChars`. Stage limits include `stageTimeoutMinutes`; fanout stages additionally support `maxConcurrency` and `maxFanoutItems`.

`fixLoop` stages contain a validator turn definition, fixer turn definition, routing policy, maximum round count, and explicit blocked behavior for unknown or exhausted outcomes. The compiled execution plan is the runtime-derived snapshot of the validated authoring model.

## Runtime Behavior

Validation first performs Zod shape validation, then compiler lint checks. Compilation produces `execution-plan.json`, not ACPX flow source. Runtime agent prompts receive a safety and output footer generated from the stage contract.

At runtime, actual agent attempts and repair attempts are recorded in `run.json`. Transient agent runtime failures get one automatic retry; the retry counts in `agentUsage.actual`, and repair-turn retries count in `repairCalls`. Agent call accounting is usage data and MUST NOT control scheduler capacity.

For `fixLoop`, each round runs the validator first. If validator output matches `routingPolicy.fixOn`, the fixer runs and the loop continues to the next round. If validator output does not require fixing, the stage completes. If validator output is unknown, or if all rounds are exhausted without a passing validation outcome, the stage blocks according to `onUnknown` or `onExhausted`.

At terminal completion, the `gate` stage writes the workflow `gateVerdict`. Verdicts `pass` and `pass_with_warnings` complete the run. Verdicts `blocked`, `failed`, and `unknown` block the run with gate-specific runtime blocked reasons. Runtime `failed` remains reserved for infrastructure failures.

## Extension Points

Supported extension points are new validated stage fields, built-in transforms, role categories, output contracts, and compiler/runtime policies documented in the relevant SPEC. Extensions MUST preserve explicit graph semantics and validation errors.

## Non-Goals

- The workflow spec is not a general-purpose workflow engine.
- The workflow spec does not support arbitrary graph cycles.
- The workflow spec does not use generated ACPX flow files as an execution contract.
- Roadmap capabilities such as ordinary parallel split/join, workflow-level loops, heterogeneous fanout, and native tool tasks are not current behavior unless separately implemented and reflected in this SPEC.

## Implementation Map

- Schema definitions -> `src/schema/workflow-spec.ts`
- Input validation -> `src/schema/input-validation.ts`
- Spec loading -> `src/schema/load.ts`
- Compiler entry points -> `src/compiler/compile.ts`, `src/compiler/compile-execution-plan.ts`
- Graph linting -> `src/compiler/lint.ts`
- Execution-plan model -> `src/compiler/execution-plan.ts`, `src/compiler/contracts.ts`
- Variable interpolation and sources -> `src/variables/interpolate.ts`, `src/variables/paths.ts`
- Built-in transforms -> `src/transformers/builtins.ts`
- `fixLoop` schema, linting, and planning -> `src/schema/workflow-spec.ts`, `src/compiler/lint.ts`, `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`
- `gate` schema, linting, planning, and runtime verdict handling -> `src/schema/workflow-spec.ts`, `src/compiler/lint.ts`, `src/compiler/compile-execution-plan.ts`, `src/runtime/stage-runner.ts`, `src/runtime/scheduler.ts`
- JSON schema generation -> `src/schema/generate-json-schema.ts`, `schemas/workflow-spec.schema.json`
- Example authoring contracts -> `workflows/examples/*.workflow.spec.json`
