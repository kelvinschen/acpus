# Stage/Task Separation and Fanout/Fanin Symmetry

This PRD records the product background for the implemented breaking stage/task workflow model. Current normative behavior is defined by `specs/`.

## Problem Statement

Acpus workflow authors cannot mix programmatic execution nodes and AI agent nodes in a single workflow. The current model couples structural orchestration (graph position, control flow) and execution definition (what work happens) inside each stage kind, making it impossible to add new execution types — such as running a shell command, invoking a tool, or calling an MCP endpoint — without introducing a whole new stage kind and modifying the entire pipeline (schema, compiler, scheduler, contracts, lint, monitor, CLI).

Additionally, fanout and reduce are separate, loosely-coupled stages. A fanout with no reduce exposes raw lane aggregation to downstream stages, a common source of errors. The `discover` stage kind exists only to feed items into fanout, yet it occupies a first-class graph node. The stage kind `decisionGate` uses a compound name that obscures its single responsibility: mid-workflow routing.

## Solution

Separate the workflow spec into two orthogonal layers:

- **Stage** (5 kinds): declares a structural role in the graph — `task`, `fanout`, `loop`, `route`, `gate`.
- **Execution** (2 modes, flat on stage): `mode: agent` (actor + prompt) or `mode: program` (operation + command/args).

Restructure fanout as a symmetric 1→N→1 scatter-gather closure where fanin (the gather step) is mandatory and internal to the fanout stage. Remove `discover` entirely. Replace `decisionGate` with `route`. Absorb `reduce` into fanout as `fanin`.

New execution capabilities (command execution, tool calls, MCP endpoints) become `mode: program` operations — no new stage kind required. New orchestration patterns (parallel branches, conditional joins) become new stage kinds — no new execution mode required.

## User Stories

### Core Stage/Task Separation

1. As a workflow author, I want to declare a program execution node in my workflow, so that I can run lint, typecheck, or visual diff as a deterministic step without hiding it inside an agent turn.
2. As a workflow author, I want to mix agent tasks and program tasks in the same workflow, so that I can have an agent generate code and then a program task run the test suite.
3. As a workflow author, I want `mode: program` to support a `command` operation, so that I can run `npm run test:visual` or `tsc --noEmit` as a first-class workflow node.
4. As a workflow author, I want new execution types to be added without changing the graph model, so that my existing workflows remain valid as the platform evolves.
5. As a workflow author, I want the stage kind to tell me the structural role (task, fanout, loop, route, gate), so that I can read the workflow graph without parsing execution details.

### Fanout/Fanin Symmetry

6. As a workflow author, I want every fanout to have a mandatory fanin step, so that downstream stages always receive a single well-structured output instead of raw lane aggregation.
7. As a workflow author, I want fanin to support agent mode, so that I can have an agent merge, deduplicate, and synthesize results from parallel lanes.
8. As a workflow author, I want fanin to support program mode, so that I can use `mergeArrays` for deterministic aggregation without invoking an agent.
9. As a workflow author, I want fanout output to be the fanin output, so that I never accidentally consume unaggregated lane data downstream.
10. As a workflow author, I want fanin to be declared inside the fanout stage, so that scatter and gather are visually and structurally coupled in the spec.

### Route Stage

11. As a workflow author, I want the routing stage kind to be called `route`, so that its name directly expresses its purpose: mid-workflow conditional routing.
12. As a workflow author, I want route to preserve first-match-wins rule evaluation and route pruning while removing the old `default` fallback, so that unmatched routes block explicitly.

### Discover Removal

13. As a workflow author, I want to provide fanout items from workflow input or prior stage output, so that I do not need a dedicated discover stage for simple item sourcing.
14. As a workflow author, I want removed discover stages to be replaced by workflow input or ordinary upstream stage outputs, so that fanout item sourcing stays explicit.

### Loop Body Consistency

15. As a workflow author, I want loop body stages to use the same stage kinds as top-level stages, so that I do not need to learn a different vocabulary for loop internals.
16. As a workflow author, I want to use `task` stages (with `mode: agent` or `mode: program`) inside loop bodies, so that I can mix agent and program work in iteration.
17. As a workflow author, I want fanout stages (with fanin) inside loop bodies, so that I can do parallel work per loop round.

### Gate Stage

18. As a workflow author, I want gate to remain the sole terminal verdict stage, so that run completion semantics are unambiguous.
19. As a workflow author, I want gate to continue treating skipped upstream dependencies as satisfied, so that unselected route branches do not block run completion.

### Runtime & Observation

20. As a runtime operator, I want the scheduler to execute fanin automatically after all fanout lanes complete, so that I do not need to schedule a separate reduce stage.
21. As a runtime operator, I want `mode: program` stages to execute deterministically (no agent, no session), so that they are fast, repeatable, and cost-zero in agent usage.
22. As a monitor user, I want the Run Monitor View to show fanin as a selectable Stage Task under the fanout stage, so that I can inspect the complete scatter-gather lifecycle in one place.
23. As a runtime observer, I want `mode: program` runtime failures such as invalid cwd, timeout, spawn failure, or safety policy violation to produce structured error codes with actionable suggestions, so that I can understand execution problems without reading raw stderr.

### Schema & Validation

24. As a spec author, I want the schema to reject workflows where a fanout stage has no fanin, so that I catch this error at compose time rather than at runtime.
25. As a spec author, I want lint to validate that `mode: program` operations are known operations, so that typos in operation names are caught early.
26. As a spec author, I want lint to validate that `mode: program` command fields meet safety constraints (cwd, timeout, output size), so that arbitrary command execution is bounded.

### Migration

27. As a workflow author with existing specs, I want a clear migration path from `agentTask` stage kind to `task` stage with `mode: agent`, so that I can update my workflows mechanically.
28. As a workflow author with existing specs, I want a clear migration path from `decisionGate` to `route`, so that I can find-and-replace the stage kind name.
29. As a workflow author with existing specs, I want a clear migration path from standalone `reduce` to fanout `fanin`, so that I can restructure my scatter-gather patterns.
30. As a workflow author with existing specs, I want to understand what replaces `discover` stages, so that I can source fanout items differently.

## Implementation Decisions

### Schema model

The `StageSchema` discriminated union changes from 7 kinds to 5:

- `task` — flat execution fields directly on stage (mode, actor/prompt or operation/command)
- `fanout` — contains lane filters (scatter) + mandatory fanin (gather)
- `loop` — contains body stages
- `route` — replaces `decisionGate`; contains routes list + rules (program) or actor (agent), with no `default` fallback
- `gate` — terminal verdict stage; contains condition or agent verdict execution

No nested `task: { type: ... }` wrapper. The `mode` field (`"agent" | "program"`) appears only on executable objects: `task`, `route`, `gate`, and `fanin`. `fanout` and `loop` are structural containers and do not declare stage-level `mode`. No `TaskSchema` discriminated union needed.

### Task stage shape (agent)

```yaml
- id: review
  kind: task
  mode: agent
  dependsOn: [plan]
  actor: { agent: pi, mode: readOnly }
  prompt: "Review: ${plan}"
```

### Task stage shape (program)

```yaml
- id: typecheck
  kind: task
  mode: program
  dependsOn: [implement]
  operation: command
  command: npx
  args: [tsc, --noEmit]
```

### Fanout stage shape with mandatory fanin

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

Fanin mode is explicit: `"agent"` or `"program"` (declared on the fanin object).
- `mode: agent` → `actor` + `prompt` required
- `mode: program` → `operation` required; the initial operation set is `mergeArrays`

Fanin can only reduce fanout lane data. It cannot reference arbitrary upstream sources.

Fanout stage output = fanin output. Downstream stages see one aggregated result.

### Route stage shape

Program-mode route (rules, no default):
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

If no rule matches, the stage is blocked. No `default` fallback.

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

Route output is always `{ route: string }` — no `output.schema` allowed. The `routes` field is required for both modes and must match the route stage's direct downstream stage ids. The selected route stays active; the other direct downstream branches are marked skipped. The `mode` field is explicit: `"agent" | "program"`.

### Gate stage shape

Gate remains the sole terminal verdict stage. The `mode` field is explicit because `gate` is an executable object.

### Loop body stages

Loop body allows `task`, `fanout`, `route` stages — same shape as top-level stages. `gate` and `loop` remain prohibited inside loop bodies. `loop.body.output` must name a `task` or `fanout` body stage, not a `route`.

### Contract assignment

The 7-name hardcoded output contract system is replaced by per-stage `output.schema` DSL declaration. See ADR 0006 "Output Schema Declaration" section for full details.

- `mode: agent` stages: custom schema via `output.schema` or, when omitted, default base `{ summary: string, data?: unknown }`. A declared schema replaces the default base; only stage-kind implicit fields are merged. Schema drives prompt injection, output validation, and continuation retry on parse/schema failure.
- `mode: program` stages: deterministic output `{ status, data }`, no schema declaration allowed. Runtime execution failure = blocked; command non-zero exit codes are data and do not automatically block.
- `fanout` lanes: shared `laneOutput.schema` (optional) or default base. All lanes produce the same output shape.
- `fanin` output: `output.schema` for agent-mode, deterministic `{ status, data }` for program-mode.
- `route` output: `{ route: string }` only — no `output.schema` allowed. Both agent-mode and program-mode require a `routes` field listing valid downstream stage IDs.
- `gate` output: `{ verdict: "pass"|"pass_with_warnings"|"blocked"|"failed"|"unknown" }` (implicit) + optional content from `output.schema` (agent-mode only).
- Runtime metadata (`status`) overlays agent content. No lint error for name collisions — meta always wins.
- Role category → contract name mapping eliminated (no category on actor).

### Session key strategy

Session keys are stage-scoped, not role-scoped. Cross-stage session sharing is eliminated — each stage gets an independent agent session. Session key formats:
- Simple agent stage: `stage:<stageId>`
- Fanout lane: `fanout:<stageId>:item:<itemId>:lane:<laneId>`
- Fanout fanin: `fanin:<stageId>`
- Loop body stage: `loop:<loopId>:round:<N>:stage:<bodyStageId>`
- Loop body fanin: `loop:<loopId>:round:<N>:fanin:<bodyStageId>`

Context sharing between stages is done explicitly via `outputs.<stageId>` variables, not implicit session reuse.

### Variable and data flow

- Variables are declared on the stage (not on the task). The stage provides bindings; the task's prompt consumes them via `${varname}` placeholders.
- `outputs.<stageId>.*` continues to reference stage outputs. For fanout stages, the output is the fanin output. Runtime metadata such as `status` overlays content for external `outputs.<stageId>.*` references.
- Fanin receives a `results` variable bound to the fanout aggregate shape (`items`, `laneOutputs`, `blockedItems`, `skippedLanes`, and `skippedItems`; lane detail is nested under each item), equivalent to the current reduce's `from` source.
- Supported source roots are `input.*`, `outputs.*`, `item.*`, `loop.*`, and scoped `results`.

### Implicit variables

Certain variables are automatically available in prompts based on stage context — they must not be declared in `variables` and lint does not report them as undeclared:

| Context | Variable | Content |
|---|---|---|
| All stages | `input.*` | Workflow-level inputs |
| All stages | `outputs.<stageId>.*` | Upstream stage output |
| Fanout lanes | `item.*` | Current fanout item fields |
| Fanin (agent mode) | `results` | Fanout aggregate with top-level items/laneOutputs/blockedItems/skippedLanes/skippedItems; per-item lanes are nested under `results.items[]` |
| Loop body stages | `loop.round` | Current loop round number |
| Loop body stages | `loop.previous.output.*` | Previous round's loop body output |
| Loop body stages | `loop.current.output.*` | Current round's completed stage output |

### Removed concepts

- `discover` stage kind — removed entirely. Items for fanout come from `input.*` or `outputs.<stageId>.*`; there is no built-in `operation: discover` replacement.
- `reduce` stage kind — absorbed into fanout `fanin`.
- `summarize` stage kind — already deprecated, formally removed.
- `decisionGate` stage kind — renamed to `route`.
- `mode` field on route and gate — explicit `"agent" | "program"` (Change B), not inferred from field presence.
- Top-level `roles` map — removed. Actors are inline: `{ agent, mode, label? }`.
- Nested `task: { type: ... }` wrapper — removed. Execution fields are flat on the stage.
- `outputParser` field — removed. Command stdout/stderr are command data under the program task's `data` field; downstream stages decide how to interpret them.
- Route `default` field — removed. Unmatched rules block the stage.
- JSON workflow spec format — removed. Authored specs, saved workflows, and run workflow snapshots use YAML only. `execution-plan.json`, `run.json`, and output artifacts remain JSON.
- `schemaVersion` remains `acpus.workflow/v1`; old JSON v1 specs become invalid rather than being routed through a compatibility path.

### Program-mode task operations

Initial operation set for `mode: program` task stages:

| Operation | Fields | Description |
|---|---|---|
| `command` | `command`, `args?`, `cwd?`, `timeout?` | Run a shell command deterministically. Output is `{ status, data: { exitCode, stdout, stderr } }`; downstream stages are responsible for interpreting command output. |

The operation set is extensible. Future operations may include `httpRequest`, `mcpCall`, `transform`, etc.

Safety constraints for `command` operation:
- `cwd` must be within the project directory
- `timeout` defaults to 60 seconds, max 300 seconds
- Output size bounded (stdout/stderr truncated beyond limit)
- Default execution is read-only; mutation requires explicit `allowMutation: true`
- No output parser — downstream stages consume `{ status, data }` and parse `data.stdout` as needed
- A non-zero command exit code does not automatically block the stage; blocked status is reserved for runtime execution failures such as invalid `cwd`, timeout, spawn failure, safety policy violation, or inability to record bounded output.

### Compiler changes

- `compileExecutionPlan` produces `ExecutionPlanStage` shapes for the 5 new stage kinds.
- `task` stages produce a flat plan with mode and execution metadata.
- `fanout` stages produce a plan with fanin metadata (actor/prompt or operation) in addition to lanes.
- `route` stages produce a routing plan derived from the current `decisionGate` shape, with `decision` renamed to `routing`, required `routes`, and no `default`.
- `loop` body compilation unchanged in structure; body stages use new kinds.

### Runtime scheduler changes

- Fanout completion: after all lanes reach terminal state, the scheduler runs fanin before marking the fanout stage complete. This replaces the current flow where a separate `reduce` stage would be scheduled independently.
- Fanin agent mode: creates an `AgentWorkUnit` with the fanin's actor and prompt, receiving lane aggregation as input.
- Fanin program mode: runs `mergeArrays` synchronously, no agent invocation.
- Empty fanout still executes fanin with an empty aggregate. If partial fanout policy does not permit the terminal lane/item set, the fanout blocks and fanin does not run.
- `mode: program` in `task` stages: runs deterministically in `advanceDeterministicStages`. No agent work unit created.
- `markUnselectedDecisionRoutes` replaced by `markUnselectedRoutes` (route stage).
- All `decisionGate` references in runtime code replaced by `route`.
- Run Monitor View projects fanin as selectable Stage Tasks, with distinct top-level and loop-body fanin task identities. Task Detail View supports both agent and program fanin.

## Testing Decisions

### Testing philosophy

Tests assert on external behavior (schema validation results, compiled plan shapes, RunIndex state after scheduler ticks, output file contents) rather than internal implementation details. The existing three-tier pyramid (unit → integration → e2e with fake agents) is preserved.

### Primary test seams

1. **Schema validation** (`test/unit/input-validation.test.ts`, `test/unit/lint.test.ts`): Assert that new stage kinds are accepted, fanout without fanin is rejected, route `routes` match direct downstream stages, and program-mode operations are validated. Do not add tests whose only purpose is proving removed stage kinds or removed JSON authoring support are rejected.

2. **Compiler** (`test/unit/compile.test.ts`): Assert on `ExecutionPlanStage` shapes for the 5 new stage kinds. Assert that fanout plan includes fanin metadata. Assert that route plan shape includes routing metadata without a default fallback. Assert that task stages include execution metadata in their plan.

3. **Lint rules** (`test/unit/lint.test.ts`): Update existing `GRAPH_BRANCH_REQUIRES_DECISION_GATE` → `GRAPH_BRANCH_REQUIRES_ROUTE`. Add `FANOUT_FANIN_REQUIRED` lint error. Add `PROGRAM_TASK_OPERATION_UNKNOWN` lint error. Add `OUTPUT_SCHEMA_ON_PROGRAM_STAGE` lint error. Add `OUTPUT_SCHEMA_ON_ROUTE` lint error. Update `GATE_PROGRAM_CONDITION_REQUIRED` to work with explicit mode.

4. **Scheduler** (`test/unit/runtime-stability.test.ts`): Assert that fanout completion triggers fanin. Assert fanin agent mode produces correct output. Assert program fanin `mergeArrays` produces `{ status, data }`. Assert `mode: program` command stages run deterministically without agent invocation and non-zero exit codes remain completed command data. Assert unmatched route rules block the stage.

5. **Schema DSL** (`test/unit/schema-dsl.test.ts`): Assert that DSL strings parse correctly to AST. Assert that invalid DSL produces syntax errors with line/column. Assert that Zod schemas generated from AST validate correctly. Assert that gate/route implicit fields merge correctly.

6. **E2E with fake agents** (`test/e2e/fake/stage-kinds.test.ts`): End-to-end workflows using the 5 new stage kinds. Verify complete run lifecycle including fanout-with-fanin, route branching, `mode: program` execution, and gate verdict.

7. **Workflow spec fixtures** (`workflows/examples/`): Migrate all existing fixtures to the new model. These serve as both documentation and integration test inputs.

### Prior art

- Schema validation tests follow the pattern in `test/unit/lint.test.ts` (assert on error codes).
- Compiler tests follow the pattern in `test/unit/compile.test.ts` (assert on plan shapes and prompt footers).
- Scheduler tests follow the pattern in `test/unit/runtime-stability.test.ts` (inject `FakeAgentRuntime`, tick `syncRun`, assert on `RunIndex`).
- E2E tests follow the pattern in `test/e2e/fake/stage-kinds.test.ts` (full run lifecycle with fake agents).

### What makes a good test

- A schema test is good when it asserts that a specific invalid spec produces a specific error code.
- A compiler test is good when it asserts that a valid spec produces a plan with the expected stage shapes.
- A scheduler test is good when it asserts that a complete run reaches the expected terminal status with the expected stage states and output contents.
- An e2e test is good when it exercises a complete workflow lifecycle with realistic stage interactions.

## Out of Scope

- **taskRef indirection** — deferred to a future iteration. Tasks are inline only.
- **Parallel stage kind** — a new `parallel` stage kind for ordinary parallel branches and joins (capability gaps #1, #2) is not part of this PRD. It will be a natural extension of the 5-kind model.
- **Conditional join / selected-route join** — capability gap #3. Depends on parallel stage or join policy on existing stages.
- **Route output alias** — capability gap #4. Independent of this change; the `route` stage rename does not block or require it.
- **Per-item subgraph / map pipeline** — capability gap #5. Independent of this change.
- **Dynamic worklist expansion** — capability gap #8. Independent of this change.
- **toolTask as a separate execution type** — tool/MCP calls are handled as `mode: program` operations. A separate `toolTask` type may be introduced later if the operation model proves insufficient.
- **Combined fanin mode** (program pre-process + agent post-process) — explicitly rejected; fanin is either agent-mode or program-mode, never both.
- **Gate or loop inside loop body** — remains prohibited.
- **Breaking change compatibility period** — no backward compatibility shim for old stage kinds or JSON spec format. Workflow specs must be migrated to YAML, but tests should focus on the new current behavior rather than reverse assertions for removed behavior.

## Further Notes

### Migration guide (spec-level)

| Old | New | Action |
|---|---|---|
| `kind: "agentTask"` | `kind: task, mode: agent` | Remove nested task; move `role` → inline `actor: { agent, mode, label? }`; add `mode: agent` |
| `kind: "decisionGate"` | `kind: route, mode: program` | Replace kind; add explicit `mode`; add `routes` list matching direct downstream stages; remove `default` |
| `kind: "discover"` | N/A | Remove the stage; source fanout items from workflow input or an ordinary upstream stage output |
| `kind: "reduce"` | Fanout `fanin` field | Move into the upstream fanout stage as `fanin` |
| `kind: "gate"` | `kind: gate, mode: program` | Add explicit `mode`; otherwise unchanged |
| `kind: "summarize"` | N/A | Already deprecated; remove from spec |
| Top-level `roles` map | Inline `actor` on each stage/lane/fanin | Move role fields into `actor: { agent, mode, label? }`; remove `category` |
| `contract: implementation/validation` | `output: { schema: \| ... \| }` | Declare output schema explicitly using DSL |
| JSON spec format | YAML spec format | Convert spec file to `.workflow.spec.yaml`; saved workflows and run workflow snapshots also use YAML |
| `dependsOn` references to reduce stages | `dependsOn` references to fanout stages | Reduce stage ID disappears; downstream stages depend on the fanout stage directly |
| `outputs.<reduceId>.summary` | `outputs.<fanoutId>.summary` | Update variable sources to reference fanout stage ID |

### ADR reference

- ADR 0006: `docs/adr/0006-stage-task-separation-and-fanout-fanin-symmetry.md`
- CONTEXT.md: identifies the current stage/task terminology and keeps normative behavior delegated to `specs/`

### Recommended implementation order

1. **Schema and lint** — New `StageSchema` (5 kinds), flat execution fields, `FaninSchema`, schema DSL parser. Updated lint rules. YAML-only authoring/saved workflow/run snapshot loading.
2. **Compiler** — New plan shapes for 5 stage kinds. Fanout plan includes fanin metadata. Output schema AST stored in plan. Stage-scoped session keys.
3. **Runtime scheduler** — Fanout fanin execution after lane completion. `mode: program` deterministic execution. Route stage replaces decisionGate. Output schema Zod generation from AST.
4. **Contracts and monitor** — Schema DSL drives prompt injection, validation, and continuation retry. Monitor display for fanin sub-step.
5. **Examples, fixtures, and tests** — Migrate all workflow specs and test fixtures to the new model (YAML).
