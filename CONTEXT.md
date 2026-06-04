# Acpus — Terminology Reference

This document defines the repository language used to separate normative design specifications, developer-facing documentation, historical records, and agent-facing maintenance rules. Terminology below reflects current usage in **Acpus** (`acpus`, CLI binary `acpus`, state directory `.acpus/`), built on the upstream `acpx` agent runtime.

Current implementation truth remains in `specs/`. ADR and PRD documents provide decision and product background; they do not override the current SPEC files.

## Document Kinds

**Specification** (`specs/`):
A normative, up-to-date design and implementation contract for a project module. Specifications use structured language and define current behavior, interfaces, invariants, and implementation responsibilities.
_Avoid_: design doc, plan, proposal

**Developer Documentation** (`docs/`):
Readable explanatory material intended to help developers understand, use, or troubleshoot the project. Developer documentation may reference specifications but is not itself normative.
_Avoid_: spec, implementation contract

**Historical Archive** (`docs/archive/`):
Non-normative records of past plans, validation runs, handoffs, investigations, or decisions that are preserved for context. Archived material must not be treated as current implementation truth.
_Avoid_: current docs, active plan

**Roadmap** (`docs/roadmap/`):
Non-normative future work, accepted direction that is not yet implemented, or known capability gaps. Roadmap material must not be treated as current implementation truth.
_Avoid_: specification, historical archive

## Agent Terms

**Agent Instruction** (`AGENTS.md`):
Repository-level rules that constrain AI agents working on code changes. Agent instructions define required maintenance behavior for specifications and documentation.
_Avoid_: agent spec, contributor guide

**Agent Concurrency**:
The number of agent work units that may be active at the same time. Agent concurrency is not a count of internal retry calls inside one active work unit.
_Avoid_: agent call budget, total agent calls

**Agent Call**:
A runtime interaction with an agent used for usage reporting and attempt accounting. Agent calls are distinct from agent concurrency.
_Avoid_: active agent, concurrency slot

**Agent Work Unit**:
A schedulable unit of agent-backed workflow work, such as a stage attempt, fanout lane attempt, or Loop Body stage attempt. Agent work units are the entities whose runtime state is tracked for concurrency and progress.
_Avoid_: agent, task, active agent

**Agent Task Retry**:
A follow-up agent call for the same Agent Work Unit after the previous call did not produce a usable terminal result. Agent Task Retry reasons are `runtime`, `stale`, and `continuation`. All reasons share the same fixed retry budget for the work unit; output parse and schema failures use continuation retry.
_Avoid_: format-only turn, recovery call, separate retry mechanism

## Runtime & Observation Surfaces

**Run**:
One complete execution of a workflow spec under `acpus`. Each run is assigned a numbered identifier and produces replayable state within `.acpus/`.
_Avoid_: execution instance, job, pipeline run

**Run Monitor View**:
A lightweight observation surface for current run, stage, and Agent Work Unit progress. A Run Monitor View is not a runtime report, audit timeline, or scheduler state source.
_Avoid_: report view, dashboard state, web UI model

**Run Diagnostics View**:
A lightweight observation surface for runtime diagnostics used by recovery and troubleshooting workflows. A Run Diagnostics View is separate from report generation and does not define a user-facing report surface.
_Avoid_: report view, detailed report, diagnostic report

**Stage Task** (observation surface):
A selectable unit of work shown under a stage in the Run Monitor View. A Stage Task represents one executable workflow node or fanout lane and may be agent-backed or deterministic program-backed. "Stage Task" is an observation-surface concept only; it does not correspond to the spec-level Task (inline execution definition within a stage).
_Avoid_: agent, Agent Work Unit, active agent, task (when referring to the spec-level concept)

**Task Detail View**:
A focused observation surface for one selected Stage Task, including lightweight metadata and bounded previews of related artifacts. A Task Detail View is loaded on demand and is separate from the Run Monitor View.
_Avoid_: Work Unit Detail View, report detail, full artifact view, expanded monitor view

## Workflow Structure

The terms in this section describe the current stage/task workflow model implemented by ADR 0006 and specified under `specs/`.

**Workflow Spec**:
The declarative definition of a workflow consumed by the Compose commands (`plan`, `save`) and executed by `acpus run`. A workflow spec defines stages and inter-stage dependencies. Each stage declares its kind (structural role) and, where applicable, inline execution work.
_Avoid_: pipeline config, job definition, workflow YAML

**Stage**:
A named node in the workflow graph that declares a structural role — task execution, parallel fanout, bounded loop, conditional routing, or terminal verdict. A stage defines execution order via `dependsOn` and may contain inline execution fields. Stage and Task are separated: stage answers "how is this work structured in the graph"; task answers "what execution happens." Executable objects are `task`, `route`, `gate`, and `fanin`: `task`, `route`, and `fanin` declare an explicit `mode: "agent" | "program"`; `gate` defaults to program mode when `mode` is omitted and uses explicit `mode: agent` for agent-backed verdicts. `fanout` and `loop` are structural containers.
_Avoid_: step, phase, section, task (when referring to the graph node)

**Task**:
An inline execution definition within a `task` stage that specifies what work to perform and how. A task is determined by the stage's `mode` field: `mode: agent` (AI agent invocation, requires `actor` + `prompt`) or `mode: program` (deterministic program execution, requires `operation` + operation-specific fields). Tasks are always contained within stages; they are not standalone graph nodes. No nested `task: { type: ... }` wrapper — execution fields are flat on the stage.
_Avoid_: activity, operator, work unit, agentTask, programTask (as nested type names)

**Actor**:
An inline declaration of who performs work within a stage, fanin, or fanout lane. An actor is `{ agent, mode, label? }`. The `agent` field names the AI agent or runtime. The `mode` field (not to be confused with stage-level `mode`) controls filesystem access: `denyAll`, `readOnly`, or `edit`. The optional `label` field is a display label for the monitor (e.g., `label: reviewer`, `label: reducer`).
_Avoid_: role, agent reference, performer

**task stage**:
A stage that contains exactly one inline task. The simplest and most common stage kind. Downstream stages see the task's output as the stage output.
_Avoid_: agent stage, simple stage

**fanout stage**:
A stage that scatters work across N parallel lane invocations (scatter) and then gathers results through a mandatory fanin step (gather). Fanout and fanin form a symmetric 1→N→1 closure: downstream stages see one aggregated output, not individual lane results. The fanin is mandatory — every fanout must declare a gather step (either agent-mode or program-mode).
_Avoid_: map stage, parallel stage, scatter stage

**fanin**:
The mandatory gather step within a fanout stage that aggregates lane results into a single output. A fanin declares an explicit `mode: "agent" | "program"`. In agent mode, an actor and prompt are required. In program mode, the initial built-in operation is `mergeArrays`. Fanin can only aggregate fanout lane data.
_Avoid_: reduce, aggregation, merge step

**Heterogeneous Fanout**:
A fanout pattern where work items, or lanes for the same work item, may be assigned to different actors or agents within one fanout stage.
_Avoid_: multi-agent fanout, mixed-agent fanout, agent selection fanout

**Fanout Core**:
The shared fanout semantics for expanding items into lane work, deriving fanout statuses, and constructing aggregate fanout results across top-level and Loop Body fanout usage.
_Avoid_: fanout runner, fanout scheduler, generic workflow executor

**Lane**:
A named execution channel within heterogeneous fanout that binds selected work items to an actor and prompt. A lane may declare its own prompt or inherit the fanout stage prompt.
_Avoid_: agent option, branch, lane group, lane selector, lane collection

**route stage**:
A stage that evaluates conditional rules or agent decision and selects exactly one downstream branch. The route stage produces a `route` field; the runtime automatically marks unselected direct downstream branches as `skipped`. Route stages require a `routes` field whose entries exactly match direct downstream stage IDs — both agent-mode and program-mode. Program-mode route has no `default` fallback; unmatched rules block the stage. No `output.schema` is allowed on route stages — their output is always `{ route: string }`. Route stages cannot be terminal — they route mid-workflow, not judge run completion.
_Avoid_: decision gate, branching node, switch

**gate stage**:
A terminal stage that evaluates a condition and produces a `verdict` (pass, pass_with_warnings, blocked, failed, unknown). A workflow must have exactly one gate stage and it must be the only terminal stage. Program gate is the default; it guards the effective upstream output and wraps that output as `data` while keeping gate control fields (`status`, `summary`, `verdict`, `blockedReason`) at the top level. Agent gate is selected with explicit `mode: agent` and does not automatically pass through upstream output. The gate's verdict determines the run's final status. Gate stages treat `skipped` upstream dependencies as satisfied, so unselected route branches do not block run completion.
_Avoid_: quality gate (when meaning the stage kind), final stage, checkpoint

**Cadenza**:
An agent-backed block within a stage where the agent operates with broad discretion over approach and output format, constrained only by the surrounding stage contract.
_Avoid_: free-form task, open-ended agent call

**Output Schema**:
A per-stage declaration of the output shape for `mode: agent` executable objects, expressed in a simplified TypeScript-aligned DSL. The output schema is a single concept that drives both prompt injection (constraining agent output) and runtime validation (Zod schema generation). `mode: program` executable objects do not declare output schemas — their output is deterministic. Output schemas are optional; when omitted, `mode: agent` executable objects default to the base schema `{ summary: string, data?: unknown }`. A declared schema replaces the default base; only stage-kind implicit fields are merged.
_Avoid_: contract, output contract, output format

**laneOutput**:
A shared output schema declaration on a fanout stage that applies to all lanes. All lanes within a fanout produce the same output shape. When omitted, lanes default to the base schema.
_Avoid_: lane contract, per-lane schema

**Implicit Mandatory Field**:
A runtime-critical output field owned by the stage kind, not user-declarable. Gate stages own `verdict`; route stages own `route`. These fields are automatically merged into the agent's prompt schema and runtime validation. User-declared content fields are separate; meta fields overlay content on name collision (meta wins, no lint error).
_Avoid_: contract field, required field (when meaning stage-kind-owned)

**Implicit Variable**:
A variable automatically available in prompts based on stage context, without requiring a `variables` declaration. Implicit variables are: `input.*` (all stages), `outputs.<stageId>.*` (all stages), `item.*` (fanout lanes), `results` (fanin agent mode, bound to the fanout aggregate shape with top-level `items`, `laneOutputs`, `blockedItems`, `skippedItems`, and `skippedLanes`), `loop.round`, `loop.previous.output.*`, and `loop.current.output.*` (loop body stages). Lint does not report implicit variables as undeclared.
_Avoid_: magic variable, hidden variable

**Intermezzo**:
A hook that executes between stages, used for cross-stage validation, state propagation, or conditional branching before the next stage begins.
_Avoid_: pre/post hook, middleware, interceptor

## Loop Constructs

**Workflow-Level Bounded Loop**:
A workflow control pattern that repeats a bounded set of workflow stages until an explicit exit condition is met or a configured round limit is exhausted.
_Avoid_: generalized fixLoop, arbitrary cycle, workflow recursion

**Loop Body**:
The scoped set of stages repeated by a Workflow-Level Bounded Loop. A Loop Body is part of the loop container, not a set of top-level workflow stages.
_Avoid_: referenced stages, top-level loop stages

**Loop Body Output**:
The explicitly selected Loop Body stage output that represents the result of one Loop Round. A Loop Body Output is chosen by loop configuration rather than inferred from terminal body stages.
_Avoid_: inferred terminal output, last body stage

**Loop Round**:
One complete execution of a Loop Body within a Workflow-Level Bounded Loop. Loop continuation or exit is evaluated at Loop Round boundaries.
_Avoid_: iteration step, partial round, mid-loop break

**Loop Output**:
The top-level stage output emitted by a Workflow-Level Bounded Loop. A Loop Output summarizes the latest round and preserves round history without promoting Loop Body stage outputs to top-level workflow outputs.
_Avoid_: flattened body outputs, final body stage output

## Reporting & List

**Coda**:
The final report produced at the conclusion of a run, summarising outcomes across all stages, loop rounds, and fanout lanes.
_Avoid_: final report, summary, post-run output

**List**:
The template and archival system accessible via `acpus list` and `acpus show`, storing reusable workflow specs and completed run records.
_Avoid_: template library, registry, run history
