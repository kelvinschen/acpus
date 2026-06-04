# Stage/Task Separation and Fanout/Fanin Symmetry

Status: implemented

This ADR records the decision behind the current breaking stage/task workflow model. Current normative behavior is defined by `specs/`.

## Decision

Separate the workflow spec model into two orthogonal layers: **Stage** (graph node — structural orchestration) and **Task** (inline execution definition — what work happens). Restructure fanout as a symmetric scatter-gather closure where fanin (reduce) is mandatory and internal. Remove `discover` as an independent concept and absorb `reduce` into fanout.

### Stage kinds (5, down from 7)

| Stage Kind | Role | Contains |
|---|---|---|
| `task` | Execute one unit of work | Flat execution fields: `mode: agent` (actor + prompt) or `mode: program` (operation + command) |
| `fanout` | Parallel scatter-gather | Lanes (scatter) + mandatory fanin (gather) |
| `loop` | Bounded iteration | Body stages × rounds |
| `route` | Conditional branching | Rule evaluation + route pruning (renamed from `decisionGate`) |
| `gate` | Terminal verdict | Condition evaluation + run termination |

### Key structural changes

1. **`agentTask` demoted from stage kind to execution mode.** The current `agentTask` stage becomes a `task` stage with `mode: agent`. No nested `task: { type: ... }` wrapper.
2. **`discover` removed.** Glob/git discovery is not a first-class stage and is not retained as a built-in program operation. Items for fanout come from workflow input or prior stage output.
3. **`reduce` absorbed into fanout as `fanin`.** Every fanout stage must declare a fanin step (agent-mode or program-mode). Fanin can only reduce fanout lane data. The current standalone `reduce` stage kind is eliminated.
4. **`decisionGate` replaced by `route`.** The stage kind is renamed to reflect its role (mid-workflow routing), and the old `default` fallback is removed. Program-mode route rules are first-match-wins; no match blocks the route stage.
5. **`gate` unchanged** in behavior. It remains the sole terminal stage kind.
6. **`mode` is explicit on executable objects only.** `task`, `route`, `gate`, and `fanin` declare `mode: "agent" | "program"` explicitly. `fanout` and `loop` are structural containers and do not declare stage-level `mode`.
7. **Loop body stages use the same stage kinds as top-level.** A loop body may contain `task`, `fanout`, and `route` stages — same shape as top-level stages. `gate` and `loop` remain prohibited inside loop bodies.
8. **Tasks are flat, not nested.** Execution fields (mode, actor/prompt or operation/command) are directly on the stage. No `task: { type: ... }` wrapper. A `taskRef` indirection may be added in a future iteration when reuse demand is real.
9. **`role` replaced by inline `actor`.** The top-level `roles` map is removed. Each stage/fanin/lane declares an inline `actor: { agent, mode, label? }`. The `category` field is removed — output schemas are declared explicitly, not derived from role category.

### Fanout/fanin symmetry

```
Before (asymmetric):
  discover ──→ fanout ──→ reduce ──→ gate
  (3 independent stages, 2 dependsOn edges)

After (symmetric):
  task ──→ fanout ──→ gate
            ├── lanes (scatter)
            └── fanin (gather, mandatory)
  (1 stage = scatter + gather closure, downstream sees 1 output)
```

Every fanout is a 1→N→1 closure. Downstream stages see one aggregated output, never raw lane results. This eliminates the class of errors where a fanout has no reduce and downstream stages receive unstructured lane data.

### Example: task stage (agent)

```yaml
- id: review
  kind: task
  mode: agent
  dependsOn: [plan]
  actor: { agent: pi, mode: readOnly }
  prompt: "Review the plan: ${plan}"
```

### Example: fanout stage with agent fanin

```yaml
- id: review_files
  kind: fanout
  dependsOn: [plan]
  items: { source: outputs.plan.files }
  lanes:
    - id: runtime
      actor: { agent: pi, mode: readOnly }
      when: { source: item.area, op: eq, value: runtime }
  fanin:
    mode: agent
    actor: { agent: aiden, mode: readOnly, label: reducer }
    prompt: "Merge and deduplicate: ${results}"
```

### Example: program fanin

```yaml
fanin:
  mode: program
  operation: mergeArrays
```

### Example: route stage (renamed from decisionGate)

Program-mode route (rules, no fallback):
```yaml
- id: route_after_review
  kind: route
  mode: program
  dependsOn: [review]
  routes: [validate, rollback, blocked]
  rules:
    - when: { source: outputs.review.status, op: eq, value: completed }
      to: validate
    - when: { source: outputs.review.status, op: eq, value: blocked }
      to: rollback
```

If no rule matches, the stage is blocked (no `default` fallback).

Agent-mode route (agent selects from routes list):
```yaml
- id: route_after_review
  kind: route
  mode: agent
  dependsOn: [review]
  routes: [validate, rollback, blocked]
  actor: { agent: pi, mode: readOnly }
  prompt: "Based on the review results, decide the next step."
```

Route output is always `{ route: string }` — no `output.schema` allowed. The `routes` field is required for both modes and must match the route stage's direct downstream stage ids. The selected route stays active; the other direct downstream branches are marked skipped.

### Example: task stage (mode: program)

```yaml
- id: visual_diff
  kind: task
  mode: program
  dependsOn: [implement]
  operation: command
  command: npm
  args: [run, test:visual]
```

## Output Schema Declaration

### Decision

Replace the 7-name hardcoded output contract system with a per-stage **output schema declaration** using a simplified TypeScript-aligned DSL. The output schema is a single concept that drives both prompt injection (constraining agent output) and runtime validation (Zod schema generation).

### Syntax

The DSL supports: primitives (`string`, `number`, `boolean`, `unknown`, `null`), string literals (`"pass"|"fail"`), arrays (`TypeExpr[]`), objects (`{ key: TypeExpr, optionalKey?: TypeExpr }`), unions (`TypeExpr | TypeExpr`). No `any`, no `Record`, no type aliases. When `output.schema` is omitted, agent executables default to `{ summary: string, data?: unknown }`.

```yaml
- id: review
  kind: task
  mode: agent
  actor: { agent: pi, mode: readOnly }
  prompt: "Review and produce findings."
  output:
    schema: |
      { findings: { file: string, severity: "critical"|"high"|"medium"|"low", message: string }[], summary: string }
```

### Implicit mandatory fields (stage-kind owned)

Gate and route stages have runtime-critical fields that are **not user-declarable** — they are implicitly merged by the runtime:

| Stage kind | Implicit field | Type |
|---|---|---|
| `gate` | `verdict` | `"pass" \| "pass_with_warnings" \| "blocked" \| "failed" \| "unknown"` |
| `route` | `route` | `string` |

The agent sees the merged schema (implicit + content). The user only declares content fields.

### Where output.schema is allowed

| Stage Kind | Mode | `output.schema` | `laneOutput.schema` | Default output |
|---|---|---|---|---|
| `task` | `agent` | ✅ optional | — | `{ summary: string, data?: unknown }` |
| `task` | `program` | ❌ forbidden | — | `{ status, data }` (runtime-constructed) |
| `fanout` | — | ❌ (fanout output = fanin output) | ✅ optional (shared by all lanes) | Lanes default: `{ summary: string, data?: unknown }` |
| fanin | `agent` | ✅ optional | — | `{ summary: string, data?: unknown }` |
| fanin | `program` | ❌ forbidden | — | `{ status, data }` |
| `route` | `agent` | ❌ forbidden | — | `{ route: string }` — agent selects from `routes` list |
| `route` | `program` | ❌ forbidden | — | `{ route: string }` — rule evaluation selects from `routes` list |
| `gate` | `agent` | ✅ optional (content merged with implicit `verdict`) | — | `{ verdict: ... }` only |
| `gate` | `program` | ❌ forbidden | — | `{ verdict: ... }` (runtime-constructed) |
| `loop` | — | ❌ | — | Loop body output, not user-declarable |

### Key rules

1. **`output.schema` is only valid for `mode: agent` (except route).** `mode: program` produces deterministic output — no schema declaration needed. Program runtime failures such as invalid `cwd`, timeout, spawn failure, or safety policy violation block the stage without an Agent Task Retry. A command's non-zero exit code is ordinary command data and does not automatically block the stage.
2. **No 3-tier contract derivation.** `mode: agent` stages default to the same base schema (`{ summary: string, data?: unknown }`) only when `output.schema` is omitted. If a user declares `output.schema`, that declaration replaces the default base; only stage-kind implicit fields are merged. No category-based contract assignment (implementation/validation/base) remains.
3. **`laneOutput.schema` on fanout.** All lanes share one output schema. This replaces the old `FANOUT_CONTRACT_MISMATCH` lint rule with an explicit declaration.
4. **Meta overlays content.** Runtime metadata fields (`status`, `verdict`) are stored separately from agent content. On external reference (`outputs.<stageId>.xxx`), meta takes priority over content. No lint error for name collisions — meta always wins. `route` is not a meta/content overlay case — it is the sole output of route stages.
5. **No shortcuts.** No `@implementation` or `@validation` shorthand. Users write explicit schemas. Common patterns can be added as DSL extensions later.
6. **Route requires `routes` list.** Both agent-mode and program-mode route stages must declare a `routes` field listing the stage's direct downstream stage ids exactly. For agent-mode, the prompt informs the agent of valid routes. For program-mode, the `rules` must target stage ids within `routes`.

### DSL → Zod compilation pipeline

1. **Spec load time:** Parse DSL string → AST (serializable tree). Validate syntax.
2. **Compile time:** AST → generate `schemaForPrompt` (the DSL string itself, directly injected into the prompt footer). AST stored in execution plan.
3. **Runtime:** On first use, generate Zod schema from AST. Cache per-stage.

The execution plan stores the AST (not Zod objects) because the plan is serialized to `execution-plan.json`. Zod generation is deferred to runtime.

### Prompt injection

The DSL string is injected directly into the agent's prompt footer — no intermediate `schemaForPrompt` object, no `schemaDescriptor()` transformation. For gate stages, the runtime merges the implicit `verdict` field into the DSL string before injection. Route stages inject the `routes` list as a constraint ("you must output one of: fix, gate") rather than a content schema.

### What this replaces

- `contractNameForStage()` and the 7-name enum (`base`, `implementation`, `validation`, `decision`, `discover`, `gate`, `diagnostic`) → per-stage `output.schema` DSL declaration + implicit mandatory fields
- `schemaDescriptor()` → direct DSL string injection
- `schemaForContract()` → runtime Zod generation from AST
- `minimalExampleForContract()` → removed (the DSL is self-descriptive)
- Role category → contract name mapping → eliminated (no category on actor)
- `FANOUT_CONTRACT_MISMATCH` lint → `laneOutput.schema` explicit declaration
- `decision` contract for route stages → `routes` list + `{ route: string }` deterministic output
- JSON spec format → YAML only (no backward compatibility with JSON specs)

### Spec format: YAML only

Workflow specs are written exclusively in YAML. JSON format is not supported for authored specs, saved workflows, or run workflow snapshots. This is a clean break — existing JSON specs must be migrated. The file extension is `.workflow.spec.yaml`.

YAML is chosen for token efficiency (AI authoring) and readability (multi-line prompts, DSL schema strings with `|` block scalars). `execution-plan.json`, `run.json`, and output artifacts remain JSON internal artifacts.

The schema version string remains `acpus.workflow/v1`; compatibility is not version-split. Old JSON v1 specs become invalid under the new authoring contract.

### Implicit variables

Certain variables are automatically available in prompts based on stage context — they must not be declared in `variables` and lint does not report them as undeclared:

| Context | Variable | Content |
|---|---|---|
| All stages | `input.*` | Workflow-level inputs |
| All stages | `outputs.<stageId>.*` | Upstream stage output |
| Fanout lanes | `item.*` | Current fanout item fields |
| Fanin (agent mode) | `results` | Fanout aggregate with top-level items/laneOutputs/blockedItems/skippedItems/skippedLanes; per-item lanes are nested under `results.items[]` |
| Loop body stages | `loop.round` | Current loop round number |
| Loop body stages | `loop.previous.output.*` | Previous round's loop body output |
| Loop body stages | `loop.current.output.*` | Current round's completed stage output |

No additional implicit variables are planned. If a future need arises, it should go through the same mechanism (runtime-injected, no declaration required, lint-aware).

## Considered Options

- **Keep current model.** All 7 stage kinds remain, each coupling structure and execution. No programTask or toolTask capability. Fanout and reduce remain separate stages.
- **Stage/task separation with task reference.** Tasks are defined in a top-level `tasks` map and stages reference them by `taskRef`. Maximum reuse but introduces session-key continuity issues, variable interface declarations, and fanout-lane referencing complexity.
- **Stage/task separation with flat execution fields (chosen).** Execution fields (mode, actor/prompt or operation/command) are directly on executable objects. `mode: "agent" | "program"` discriminates execution type for `task`, `route`, `gate`, and `fanin`; `fanout` and `loop` remain structural containers. `taskRef` can be added later.
- **Full Argo-style model.** Route and gate conditions become edge-level `when` clauses, not stage kinds. Decentralized routing eliminates the centralized decisionGate. Rejected because: agent workflows need a centralized quality gate (reliability), and exclusive-or routing is more reliable when enforced by a single node (first-match-wins) than by independent edge conditions that may conflict or gap.

## Consequences

### Schema changes

- `StageSchema` discriminated union changes from 7 kinds to 5: `task`, `fanout`, `loop`, `route`, `gate`.
- No nested `task: { type: ... }` wrapper. Execution fields are flat on executable objects. `mode: "agent" | "program"` discriminates execution type for `task`, `route`, `gate`, and `fanin`.
- `FanoutStageSchema` gains mandatory `fanin` field and optional `laneOutput` field.
- `LoopBodyStageSchema` allows `task`, `fanout`, `route` (not `gate`, not `loop`).
- `decisionGate` is replaced by `route` across all schema, compiler, runtime, lint, contracts, CLI, and monitor code. This is a rename plus removal of the old `default` fallback.
- `discover` and `reduce` stage kinds removed. `discover` is not retained as a built-in program operation.
- `summarize` stage kind removed (already deprecated).
- Spec format is YAML only for authored specs, saved workflows, and run workflow snapshots. `execution-plan.json`, `run.json`, and output artifacts remain JSON.
- Top-level `roles` map removed. Actors are inline: `{ agent, mode, label? }`.

### Runtime changes

- Fanout completion now always runs fanin before marking stage complete.
- Fanout stage output is fanin output, not raw lane aggregation.
- Scheduler fanout pool logic absorbs fanin execution after all lanes complete.
- `markUnselectedDecisionRoutes` renamed to reflect `route` stage kind.
- Run Monitor View projects fanin as selectable Stage Tasks, with Task Detail View support for agent and program fanin.
- Program-mode route and gate remain deterministic execution paths, but route behavior changes by removing `default`.
- **Session keys are stage/work-unit scoped, not role-scoped.** Cross-stage session sharing is eliminated. Each agent work unit gets an independent agent session. Session key formats:
  - Task agent stage: `agent:<actorLabel>`
  - Route agent stage: `route:<stageId>`
  - Gate agent stage: `gate:<stageId>`
  - Fanout lane: `fanout:<stageId>:item:<itemId>:lane:<laneId>:agent:<actorLabel>`
  - Fanout fanin: `fanin:<stageId>`
  - Loop body agent stage: `loop:<loopId>:round:<N>:stage:<bodyStageId>:agent:<actorLabel>`
  - Loop body fanout lane: `loop:<loopId>:round:<N>:stage:<bodyFanoutId>:item:<itemId>:lane:<laneId>:agent:<actorLabel>`
  - Loop body fanin: `loop:<loopId>:round:<N>:fanin:<bodyFanoutId>`
  - Context sharing between stages is done explicitly via `outputs.<stageId>` variables, not implicit session reuse.

### Contract changes

- The 7-name hardcoded output contract system is replaced by per-stage `output.schema` DSL declaration.
- `mode: agent` stages: custom schema via `output.schema` or, when omitted, default base `{ summary: string, data?: unknown }`.
- `mode: program` stages: deterministic output `{ status, data }`, no schema declaration. Runtime execution failure = blocked. Command exit codes are data, not automatic stage status.
- `fanout` lanes: shared `laneOutput.schema` or default base.
- `fanin` output: custom schema via `output.schema` (agent-mode) or deterministic `{ status, data }` (program-mode). The initial program fanin operation set is `mergeArrays` only.
- `route` output: `{ route: string }` only — no `output.schema` allowed.
- `gate` output: `{ verdict: ... }` + optional content from `output.schema`.
- Runtime metadata (`status`) overlays agent content. No lint error for name collisions.
- Role category → contract name mapping is eliminated entirely (no category on actor).

### Data flow changes

- Variables referencing `outputs.<stageId>.items` from a discover stage must be rewritten to reference workflow input or a prior ordinary stage output.
- Variables referencing `outputs.<reduceId>.summary` must be rewritten to `outputs.<fanoutId>.summary` (fanout output is now fanin output).
- Fanout fanin receives `results` variable bound to the current fanout aggregate shape (`items`, `laneOutputs`, `blockedItems`, `skippedItems`, and `skippedLanes`; lane detail is nested under each item). Empty fanout still runs fanin with an empty aggregate. If fanout partial policy does not permit the terminal lane/item set, the fanout blocks and fanin does not run.

### Migration strategy

This ADR was implemented as an intentional breaking replacement. Current implementation truth now lives in `specs/`; workflow specs using `agentTask`, `discover`, `reduce`, `decisionGate`, `summarize`, top-level `roles`, named output contracts, or JSON authoring must be rewritten to the current YAML stage/task/fanout/fanin/route model.

Tests should assert the new current behavior after implementation. They should not add reverse assertions whose only purpose is proving removed stage kinds or removed JSON authoring support are rejected.
