# Workflow Specification

## Status

- Current implementation: current
- Source modules: `src/schema/workflow-spec.ts`, `src/schema/load.ts`, `src/compiler/compile.ts`, `src/compiler/lint.ts`, `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`, `schemas/workflow-spec.schema.json`, `skills/acpus/examples/**/*.workflow.spec.yaml`, `workflows/examples`
- Maintenance trigger: update this spec when changing workflow schema, YAML loading, validation, linting, compilation, execution-plan shape, stage kinds, variables, limits, input/output schema declarations, example workflow specs, or the repository examples entry

## Purpose

`workflow.spec.yaml` is the stable authoring interface for Acpus workflows. The compiler validates parsed YAML objects, lints graph semantics, and compiles them into `execution-plan.json` for the runtime scheduler.

## Normative Requirements

- Workflow specs MUST use `schemaVersion: "acpus.workflow/v1"`.
- Workflow specs MUST be authored and saved as YAML.
- Workflow spec file paths MAY use `.yaml` or `.yml`.
- `loadWorkflowSpec` MUST reject non-YAML workflow spec paths with `SCHEMA_FORMAT_UNSUPPORTED`.
- YAML parse failures MUST be reported as `SCHEMA_YAML_INVALID`.
- The generated JSON Schema MUST describe the parsed YAML object.
- A workflow graph MUST declare `root`, and `root` MUST name the single dependency-free root stage.
- A workflow graph MUST have exactly one terminal `gate` stage.
- Stage dependencies MUST be expressed with `dependsOn`; specs MUST NOT use global `edges`.
- Workflow specs MAY declare `input.schema`, `input.default`, and `input.description`.
- `input.schema` MUST use the schema DSL and MUST have an object root.
- `input.default`, when present, MUST be an object and MUST satisfy `input.schema`.
- Runtime input MUST be top-level shallow-merged over `input.default` before validation.
- Runtime input MUST satisfy `input.schema`; missing required fields, unknown fields, and nested object extra fields MUST be rejected.
- The only top-level stage kinds are `task`, `fanout`, `loop`, `route`, and `gate`.
- Task, route, and fanin executable objects MUST declare `mode`; gate executable objects MAY omit `mode` and MUST default to program mode. `fanout` and `loop` MUST NOT declare stage-level `mode`.
- Agent task, route, gate, and fanin executable objects MUST declare inline `actor: { agent, mode, label? }` and `prompt`.
- Specs MUST NOT declare top-level `roles` or string role references.
- Program task stages MUST use `operation: "command"` and MUST declare `command`.
- Program task stages MAY declare `args`, `cwd`, `timeoutSeconds`, and `allowMutation`.
- Agent task and agent gate stages MAY declare `output.schema` using the schema DSL.
- Program gate stages MUST NOT declare `actor`, `prompt`, or `output.schema`.
- Route stages MUST NOT declare `output.schema`.
- Route stages MUST declare `routes`; `routes` MUST exactly equal the direct downstream stage IDs.
- Route rules MUST be evaluated first-match; when no rule matches, the route stage blocks with `ROUTE_UNMATCHED`.
- Branching MUST be expressed with `route`.
- `fanout` stages MUST declare `items.source`, non-empty `lanes`, and `fanin`.
- Fanout stages MAY declare `prompt` as the default prompt for lanes.
- Fanout lanes MUST be agent-only executable lanes with inline actors.
- Each fanout lane MUST declare `prompt` or inherit the fanout stage `prompt`.
- Each fanout item MUST execute every lane whose `when` condition is absent or evaluates true.
- A lane with `when` false or a missing `when.source` MUST be skipped and MUST NOT block the item.
- Multiple fanout lane conditions that evaluate true MUST all execute; one-of behavior is an authoring pattern created with mutually exclusive `when` conditions.
- Fanout `fanin` MUST be either agent fanin with actor and prompt or program fanin with `operation: "mergeArrays"`.
- Program fanin MUST NOT support operations other than `mergeArrays`.
- Loop stages MUST declare `maxRounds`, `body.root`, `body.output`, non-empty `body.stages`, `continueWhen`, and `onExhausted: "blocked"`.
- Loop body stages MUST support `task`, `fanout`, and `route`.
- `loop.body.output` MUST NOT name a route stage.
- Prompt placeholders MUST use `${variableName}` syntax.
- Variables MUST declare `source` and MAY declare supported built-in transforms.
- Variable source roots MUST be `input`, `outputs`, `item`, `loop`, or `results` where that root is in scope.
- `run.*` source variables are not supported.
- Top-level `limits` MAY include `stageTimeoutMinutes`.
- Stage limits MAY include `stageTimeoutMinutes`; fanout stage limits MAY also include `maxConcurrency` and `maxFanoutItems`.
- Each limit value MUST be either a positive integer number or an input-sourced binding object `{source, default?}`.
- Limit binding `source` MUST be an absolute `input.*` path.
- Limit binding `default`, when present, MUST be a positive integer number and MUST be used only when the source path is missing.
- Limit resolution MUST NOT coerce strings or non-integer numbers.
- Fanout `maxConcurrency` and `maxFanoutItems` both default to `1` when omitted.
- Specs MUST contain only the current stage kinds and operations listed in this SPEC.

## Interfaces and Contracts

Minimal YAML shape:

```yaml
schemaVersion: acpus.workflow/v1
name: example
root: task
input:
  schema: |
    {
      task: string,
      maxConcurrency?: number
    }
  default:
    task: ""
    maxConcurrency: 2
limits:
  stageTimeoutMinutes: 30
stages:
  - id: task
    kind: task
    mode: agent
    actor:
      agent: codex
      mode: readOnly
    prompt: Do the work.
  - id: gate
    kind: gate
    dependsOn: [task]
```

Input-sourced limit example:

```yaml
stages:
  - id: review
    kind: fanout
    items:
      source: input.reviewItems
    prompt: Review one item.
    limits:
      maxConcurrency:
        source: input.maxConcurrency
      maxFanoutItems:
        source: input.maxFanoutItems
        default: 50
    lanes:
      - id: reviewer
        actor: { agent: aiden, mode: readOnly }
    fanin:
      mode: program
      operation: mergeArrays
```

Authoring examples MUST live under `skills/acpus/examples/**/*.workflow.spec.yaml` so skill installs copy the real files. The repository-visible `workflows/examples` entry MUST be a relative symlink to `../skills/acpus/examples`. Saved workflows store `workflow.spec.yaml`. Runtime snapshots store the compiled `execution-plan.json` as JSON.

## Data Model

A workflow spec contains schema metadata, optional workflow input schema/default, top-level limits, stages, explicit dependencies, variables, inline actors, output schema declarations, and stage-specific configuration.

Limit binding objects are authoring-time run-start parameterization. `workflow.spec.yaml` snapshots preserve the authored binding object. Compiled `execution-plan.json` stores only resolved numeric limits.

An actor is `{ agent, mode, label? }`, where `mode` is `denyAll`, `readOnly`, or `edit`. Actor labels are display and session-key labels; they are not global role definitions.

The schema DSL supports primitives, `unknown`, literals, arrays, objects, optional keys, and unions. It does not support `any`, `Record`, or type aliases. Workflow input schema roots and workflow output schema roots MUST be objects.

Program gate output is a wrapper object. Gate control fields stay at the top level; effective upstream output is exposed as `data`. With one effective upstream output, `data` is that output. With multiple effective upstream outputs, `data` is an object keyed by upstream stage ID. Agent gate output is produced by the agent and does not automatically pass through upstream output.

Fanout final downstream output is the fanin output. The raw item/lane aggregate is internal runtime `results`.
Fanout stage `prompt`, when present, is the default prompt for lanes that omit their own prompt. Lane-level `prompt` overrides the stage-level default.
Fanout items record `lanes[]`, `laneOutputs[]`, `skippedLanes`, and item-level skip reason `NO_SELECTED_LANES` when no lanes are selected.
The agent fanin `results` aggregate exposes top-level `items`, `laneOutputs`, `blockedItems`, `skippedItems`, and `skippedLanes`. Each entry in `items` contains that item's nested `lanes`, `laneOutputs`, and `skippedLanes`.

## Runtime Behavior

Validation first performs Zod shape validation, input schema validation, input-sourced limit validation, then compiler lint checks. Compilation produces `execution-plan.json`; it does not produce ACPX flow source.

Agent prompts receive a structured output schema footer. Agent gate outputs require a `verdict`; route outputs require a valid `route` when route mode is agent. Program gate output is normalized to `{status,summary,verdict,data?}`. Program command output is normalized to `{status,data}`.

Loop rounds execute the body graph until `body.output` is produced or a body stage blocks. Loop body fanout stages run lane work, create internal `results`, execute fanin, and expose fanin output as the body stage output.

Agent fanin prompts may reference `${results}`; the compiler injects this fanin-local variable as JSON without requiring a workflow variable declaration.
For fanout stages with agent fanin, workflow variables MUST NOT declare the name `results`; that name is reserved for the fanin aggregate.
Loop body prompts and loop conditions may reference `loop.round`, `loop.current.output`, `loop.current.outputs`, `loop.previous.output`, and `loop.previous.outputs`.

## Extension Points

Supported extension points are new validated fields, built-in transforms, schema DSL additions, program task operations, program fanin operations, and compiler/runtime policies documented in the relevant SPEC.

## Non-Goals

- YAML is the only workflow authoring format.
- Actors are declared inline on executable agent objects.
- Current stage kinds and operations are the only authoring constructs.
- No arbitrary graph cycles outside `loop`.

## Implementation Map

- Schema definitions -> `src/schema/workflow-spec.ts`
- YAML loading -> `src/schema/load.ts`
- Compiler entry points -> `src/compiler/compile.ts`, `src/compiler/compile-execution-plan.ts`
- Graph linting -> `src/compiler/lint.ts`
- Execution-plan model -> `src/compiler/execution-plan.ts`
- Schema DSL -> `src/contracts/schema-dsl.ts`
- Variable interpolation and sources -> `src/variables/interpolate.ts`, `src/variables/paths.ts`
- JSON schema generation -> `src/schema/generate-json-schema.ts`, `schemas/workflow-spec.schema.json`
- Examples -> `skills/acpus/examples/**/*.workflow.spec.yaml`, exposed through `workflows/examples`
