# Recursive Workflow Runtime Implementation Goal

This roadmap record defines the goal for evolving the durable runtime from the
current supported-shape scheduler into a common recursive workflow state
machine. It is an execution guide, not current product truth. Current
implemented behavior continues to live in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status

- [x] Final target accepted: Acpus aims to execute any valid serializable
  `WorkflowIR` composition through a durable recursive workflow scheduler.
- [x] Current V1 boundary accepted: root-level composites with leaf-only child
  scopes are a useful first version, not the final runtime model.
- [x] Recursive runtime architectural decisions captured in this goal.
- [x] Neverthrow boundary alignment captured from the typed error refactor.
- [x] Recursive scheduler core implemented: the runtime now uses a recursive durable frame
  model for root scopes, composite/control nodes, branches, fanout items, loop
  iterations, and nested leaf execution.
- [x] Specs updated in `specs/runtime-spec.md` with the current recursive
  scheduler behavior.
- [x] Subagent adversarial reviews completed for the refactor phases; blocker
  findings were fixed before completion.
- [x] Public operator cancellation implemented: expose a durable `cancel` command
  and public mutation action for terminal run, dynamic `frameKey`, and dynamic
  `nodeKey` cancellation.

## Implementation Record

Completed in the TypeScript-first runtime:

- recursive frame materialization for nested `assert`, `if`, `switch`,
  `parallel`, `fanout`, and `loop` combinations;
- durable structured identity and persisted `instancePath` read models for
  frames and leaf instances;
- group members linked to child branch and fanout-item frames through
  `childFrameKey`;
- lexical scope reconstruction at arbitrary frame depth;
- nested local concurrency, cancellation, timeout, pause/resume, signal,
  replay/projection sync, fork-compatible read models, and visualization
  overlays over the recursive tree;
- targeted retry for failed dynamic leaf `nodeKey` and failed dynamic
  composite/control `frameKey`, including static alias resolution when unique;
- durable operator `cancel` for run-level cancellation and targeted dynamic
  `frameKey`/`nodeKey` cancellation, with static aliases only when they resolve
  to exactly one non-terminal target;
- clean run-control taxonomy: run controls are `pause`, `resume`, `retry`,
  `fork`, `signal`, and `cancel`; supervisor controls remain separate and
  `shutdown` is supervisor-only;
- neutral retry/cancel targeting on public mutation payloads and CLI flags via
  `target`, while signal continues to use `node` because it targets a signal
  wait by node;
- signal retry lifecycle cleanup: retrying a failed signal leaf removes the
  stale terminal signal wait before the node can await again;
- public recursive identity typing now exposes structured `InstancePath`
  values on dynamic frame and leaf read models;
- public node projection bridging reconciles static admission rows with dynamic
  scheduler rows so stale static pending rows do not coexist with dynamic rows
  for the same public work.

No blocking implementation gaps are currently known.

Non-blocking cleanup candidates from adversarial review:

- move signal await materialization out of a public raw-event injection hook on
  scheduler advance;
- rename helpers that return both leaf outputs and composite frame outputs so
  they do not pretend all completed workflow-visible outputs are leaf nodes;
- keep supervisor tick orchestration thin by separating supervisor lifecycle
  handling from run-control dispatch and run advancement.

Confirmed review findings:

- true positive, fixed: retry target naming was semantically wrong. The public
  retry surface now uses neutral `target` wording for leaf `nodeKey`,
  composite/control `frameKey`, and static alias targets.
- true positive, fixed: CLI current truth was stale for targeted retry. CLI spec
  and help now describe `--target <target-key-or-alias>`.
- true positive, fixed: failed signal retry had stale wait lifecycle risk.
  Retrying a failed signal leaf now drops the stale terminal wait row.
- true positive, fixed: public dynamic identity types were too weak. Exported
  dynamic frame and leaf read models now use the structured scheduler
  `InstancePath` type.
- true positive, fixed: public node projection bridging was accidental. Static
  admission rows are reconciled with dynamic scheduler rows.
- true positive: completed workflow-visible outputs are not all leaf node
  outputs. Helpers and public store methods named around completed node outputs
  now also include completed composite/control frame results.
- true positive, fixed: group-member ordering was underexposed for inspection.
  Public group member rows now expose `completionSequence`.
- true positive, fixed: run-level `cancel` depended on incidental root
  materialization. Scheduler run cancel now terminalizes a pending admitted run
  even before the root frame has been materialized.
- true positive, fixed: run-control appliers accepted the wider durable command
  union, including supervisor-only `shutdown`. Run-control applier interfaces
  now accept only pending run-control commands.
- true positive, fixed: the old non-scheduler targeted retry path remained
  behind neutral `target` wording. Targeted retry now goes through scheduler
  target semantics only.
- true positive, fixed: runtime spec and supervisor tests omitted durable
  `cancel` consumption. The spec now lists cancel with run commands and tests
  cover supervisor-applied cancel.
- true positive, fixed: targeted leaf cancel inside a group did not cancel the
  owning member subtree. Leaf cancel now cancels the minimal owning group member
  subtree when one exists.
- true positive, fixed: CLI target wiring was under-tested. CLI E2E now covers
  `runs retry --target` and `runs cancel --target`.
- true positive, fixed: public type contract tests were partly tautological for
  new fields. They now assert `instancePath`, `completionSequence`,
  `RuntimeMutationAction`, and `RuntimeMutationInput.target` shapes directly.
- true positive, fixed: static-to-dynamic public node projection bridging lacked
  a direct oracle. Store tests now assert static placeholder rows are replaced
  by dynamic scheduler rows.
- true positive, non-blocking: signal await behavior currently enters
  scheduler advance through a public raw-event hook. The behavior is functional,
  but the boundary is too powerful for a public API.
- true positive, non-blocking: supervisor tick orchestration mixes supervisor
  lifecycle, durable command dispatch, and run advancement. No direct behavior
  bug was confirmed, but the module boundary is shallow.
- true positive, already reflected in spec wording: `shutdown` is a supervisor
  command, not a run command. The runtime spec now distinguishes durable
  run-command rows from durable supervisor-command rows.

Validation completed:

- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:contract`
- `pnpm test:e2e`
- `pnpm typecheck`
- `pnpm test`
- `pnpm -r build`

## Spec Update Contract

Specs change with the package behavior they describe. Runtime read models,
controls, replay, fork, scheduler behavior, and public runtime types update
`specs/runtime-spec.md` in the same change that changes current behavior. CLI
flags, JSON output, text output, and exit-code behavior update
`specs/cli-spec.md` in the same change. Core and compiler specs change only if
the serializable IR schema or authoring/compiler behavior changes.

Specs must describe only current implemented behavior. They must not document
roadmap-only intermediate states.

## Background

The current durable scheduler proves the core runtime direction: admitted runs
advance from frozen `WorkflowIR`, scheduler events rebuild projections, dynamic
node identities are stable, attempts are durable, and controls such as pause,
resume, retry, signal, fork, and replay have concrete behavior.

The current shape support is intentionally limited. Root nodes can include
composites such as `if`, `switch`, `parallel`, `fanout`, and `loop`, but child
scopes are only materialized when they are scheduler-visible leaf sequences
(`task`, `agent`, `signal`). Unsupported nested composite or pure-before-leaf
child scopes stay unmaterialized to avoid partial durable state.

That boundary is too narrow for the final product. A workflow authoring model
that supports composition cannot collapse at runtime when a `parallel`
branch contains a `fanout`, a `fanout` body contains an `if`, or a loop body
contains validation and nested work. The long-term runtime treats every
valid IR composition as one durable state machine.

## Goal

Build a general-purpose recursive durable workflow runtime where every
composite node is represented as a frame, every leaf execution is represented as
a dynamic node instance with attempts, and root execution is only the top frame
of the same state machine.

The goal is complete only when the runtime can schedule arbitrary valid
recursive `WorkflowIR` combinations expressed by the current IR schema. Internal
work can be organized however the implementation needs, but no intermediate
state is considered a product target.

The target final state includes:

- execute any valid, serializable `WorkflowIR` composition supported by the
  current IR schema;
- use one recursive frame model for root, branch, fanout item, loop iteration,
  and nested composite execution;
- preserve stable dynamic identity for every frame, node instance, group
  member, attempt, signal wait, and artifact path;
- rebuild lexical execution scope from durable projection state at any frame
  depth;
- keep scheduler materialization side-effect-free except for appending durable
  events;
- keep leaf execution behind the existing attempt executor seam;
- make pause, resume, retry, signal, timeout, cancellation, fork, replay, and
  visualization work for nested execution trees;
- avoid compatibility shims for the old YAML workflow implementation.

## Non-Goals

- Do not execute live workflow source after admission. Runtime execution stays
  based on frozen run state.
- Do not add compatibility behavior for archived workflow formats.
- Do not introduce a second scheduler implementation that callers select at
  runtime. The goal is to replace the internal materialization model while
  preserving the public runtime surface where possible.
- Do not replace the Acpus runtime with an external workflow engine or platform
  such as Temporal, Durable Task, Dapr Workflow, XState, DBOS, Inngest,
  Trigger.dev, or Hatchet.
- Do not make arbitrary JavaScript control flow durable. The target is valid
  `WorkflowIR`, not arbitrary host-language execution.

## Open Source Reuse Assessment

The recursive scheduler core is an Acpus-owned implementation.

Community durable workflow systems provide useful design references, but they
do not become runtime dependencies for this goal:

- Temporal informs event history, deterministic replay, child workflow, and
  cancellation semantics.
- Durable Task and Dapr Workflow inform orchestration history, external event,
  durable timer, retry, and child workflow semantics.
- XState informs hierarchical state machine vocabulary and actor-style
  decomposition.
- DBOS, Inngest, Trigger.dev, and Hatchet inform durable step checkpointing and
  observability patterns.

The implementation can borrow vocabulary, test scenarios, and failure-mode
analysis from these systems. It does not delegate Acpus `WorkflowIR`
materialization, scheduling, persistence, replay, artifacts, controls, or
inspection to them.

## Architecture Direction

### Frame Tree

The core runtime model becomes a recursive frame tree.

Frames describe durable control structure. The tree uses one uniform structure;
different composite kinds do not get parallel scheduler models.

Frame kinds:

- `root`: owns the root scope;
- `node`: represents non-leaf control and composite node execution, including
  `assert`, `if`, `switch`, `parallel`, `fanout`, and `loop`;
- `branch`: represents selected `if`/`switch` branches and `parallel`
  branches;
- `fanout_item`: represents one materialized fanout item;
- `loop_iteration`: represents one loop iteration body and carries the durable
  loop scope boundary for `iter`, `previous`, and `result`.

Leaf node instances describe executable work:

- `task`;
- `agent`;
- `signal`.

Leaf nodes do not create wrapper frames. They create node instances and attempts
directly under the current frame.

Public node projection stays leaf-focused. It represents scheduler-visible
work that can create attempts: `task`, `agent`, and `signal`. Composite and
control runtime state is exposed through `run.dynamic.frames`, not by
pretending frame lifecycle is the same thing as leaf node attempt lifecycle.
Read models and visualization can merge frames and leaf instances into one
display tree, but the scheduler core keeps the concepts separate.

Control and composite nodes do not execute through the leaf executor. They
advance by materializing child frames, child instances, branch decisions, group
events, loop progress, and terminal frame results. `assert` is represented as a
control `node` frame even though it has no child scope, so assertion pass/fail is
visible through the same frame lifecycle as other non-leaf nodes.

Groups are not a second execution tree. `parallel` and `fanout` use group and
member rows as coordination projections over member frames. A `parallel` member
points at a `branch` frame. A `fanout` member points at a `fanout_item` frame.
Leaf instances live under those frames. The frame tree remains the source of
execution structure.

### Deep Runtime Modules

The recursive runtime is built around a small set of deep modules rather
than more root-only branches in `materialize.ts`.

Candidate modules:

- `ExecutionIdentity`: derives and validates stable keys from structured
  instance paths.
- `FrameScopeBuilder`: rebuilds lexical scope for any frame from frozen input,
  run metadata, projection state, parent scope, fanout item data, and loop data.
- `FrameMaterializer`: computes the next scheduler events for a frame without
  executing leaf side effects.
- `FrameCompletionReducer`: propagates child terminal state to parent frames,
  groups, and root run state.
- `ControlPlanner`: turns pause, resume, retry, signal, timeout, and
  cancellation commands into scheduler events against a recursive tree.
- `ReplayOracle`: rebuilds projections and root output from events and recorded
  artifacts to verify nested execution.

The public runtime interface stays use-case oriented:

- admit a prepared run;
- advance a frozen run;
- inspect runs;
- mutate controls, including terminal `cancel`;
- control the detached supervisor;
- replay;
- visualize.

### Public Runtime Surface

The public runtime surface remains use-case oriented. `RunDetails.dynamic` is
the only public recursive execution read model. Recursive scheduler internals,
event handlers, frame interpreters, and reducers do not become public value
exports.

Public dynamic rows expose enough structured identity for operator targeting:

- target kind;
- dynamic key;
- static node id when present;
- parent frame key;
- structured instance path;
- current status and terminal reason when present.

Public node projection remains leaf-focused. Public recursive state is exposed
through dynamic frames, dynamic leaf instances, attempts, group members, and
signal waits.

`runs show --json` is the canonical operator read model for recursive targets.
CLI controls accept dynamic `nodeKey` values for leaves and dynamic `frameKey`
values for composite/control frames. `cancel` also accepts the run itself as a
terminal target. Static aliases are accepted only when they resolve to exactly
one target and return candidate dynamic keys when ambiguous.
Text output must expose enough nested target information for an operator to act
without inspecting SQLite directly.

Breaking public type changes must be explicit in this goal and covered by
runtime public API or CLI contract tests.

### Module Seam Ownership

The external scheduler seam is still run-level: advance a frozen run through a
store port and a leaf executor. Recursive frame modules are internal
implementation modules, not caller-facing interfaces.

`FrameMaterializer` accepts frozen IR plus scheduler projection state and
returns scheduler events only. `FrameScopeBuilder` is the only module that
reconstructs execution scope from projection state. Per-node-kind handlers are
private handlers behind one frame interpreter. They receive a common transition
context and do not own retry, cancellation, replay, scope, identity, or store
access.

### Neverthrow Boundary Alignment

The recursive runtime builds on the typed error boundaries introduced by the
neverthrow refactor. It does not reintroduce message matching, broad catch blocks,
or untyped control-flow exceptions at scheduler, store, or runtime use-case
boundaries.

Boundary rules:

- scheduler store-port operations that can fail through normal durable
  control flow return `Result<..., SchedulerStoreError>` through `try*`
  methods;
- scheduler driving returns `ResultAsync<AdvanceRunSummary, AdvanceRunError>`
  through `tryAdvanceRun(...)`;
- runtime use cases return `ResultAsync<..., RuntimeUseCaseError>` through
  `tryAdmitWorkflowRun(...)`, `tryAdvanceRuntimeRun(...)`,
  `trySignalRun(...)`, and `tryMutateRun(...)`;
- throwing adapters may remain at CLI-facing or compatibility edges, but they
  are not the internal composition path for recursive scheduling.

Recursive frame modules follow the same boundary split:

- `FrameMaterializer`, `FrameScopeBuilder`, `FrameCompletionReducer`, and
  `ControlPlanner` return typed results only when the caller must make a
  recoverable domain decision;
- legal workflow execution failures, such as expression errors, assertion
  failures, task or agent failures, timeouts, and duplicate fanout keys, become
  durable scheduler events that fail the owning frame or leaf;
- corrupted durable state, impossible reducer invariants, malformed scheduler
  event streams, and projection/event contradictions remain invariant failures
  and must not be disguised as workflow failures;
- ordinary local absence remains plain TypeScript `undefined`, not a wrapper.

Result values never enter serialized runtime state. `WorkflowIR`, scheduler
events, SQLite rows, command payloads, CLI JSON, artifact metadata, and replay
records stay plain JSON-compatible data. Tests for recursive runtime boundaries
should assert error tags and machine-readable fields, not formatted messages.

## Technical Foundations

The foundations below describe the technical shape required for the complete
recursive scheduler. They are not user-facing phases or partial product goals.

### 1. Recursive Frame Model

Represent all execution, including the current root-level shapes and every
nested composite shape, as one recursive frame model. Root leaf sequences, root
`assert`, root conditionals, root parallel, root fanout, root loop, and nested
composite scopes all use the same state machine.

The current supported behavior becomes a subset of the general recursive model,
not a separate compatibility path.

The implementation uses a clean abstraction:

- one frame table/projection shape for every control frame;
- one node instance table/projection shape for every executable leaf;
- no wrapper frame for executable leaves;
- group/member projections only for coordination semantics;
- parent-child frame links for completion, cancellation, retry, replay, and
  visualization.

Scheduler events are semantic truth. Frame, node instance, attempt, group
member, and signal wait tables are reducer-built read models updated atomically
with event append. Normal advance does not mutate projection rows without
scheduler events. Group members store the child frame key that defines the
cancellable and retryable member subtree.

Frame lifecycle is single-assignment within the current projection generation.
`frame.started` creates an open frame. Open frames can emit child
materialization, branch decisions, group/member coordination, loop progress, or
one terminal event. `completed`, `failed`, and `cancelled` are terminal and do
not accept later child materialization or a second terminal event. Control retry
is the only operation that can reopen failed frame state, and it does so by
appending reset/retry events while preserving historical events.

### 2. Stable Identity Contract

Promote `InstancePath` and derived keys into a documented runtime contract.
Identity rules cover arbitrary-depth paths such as:

```text
root
  node(parallel)
    branch(review)
      node(items)
        fanout_item(3)
          node(gate)
            branch(then)
              node(write)
```

The same identity contract drives frame keys, node keys, group member
keys, retry targeting, signal targeting, artifacts, fork inheritance, and
visualization overlays.

`InstancePath` is persisted as structured data. The root frame key is `root`.
Readable derived keys are display and operator identifiers; runtime logic uses
stored structured path fields and must not parse key strings. Non-leaf node
frames have a `frameKey`, not a public `nodeKey`. Public `nodeKey` values stay
reserved for executable leaves.

Branch path ids are deterministic from frozen IR. `if` uses `then` and `else`.
`switch` uses `case:<index>` and `default` unless the IR later gains explicit
case ids. `parallel` uses branch object keys. Forks with changed branch keys or
reordered switch cases treat the affected dynamic paths as identity
incompatible.

For keyed fanout, the rendered `fanout.key` is item identity and `itemIndex` is
ordering/debug metadata. Without `fanout.key`, identity falls back to zero-based
item index and is order-sensitive. Rendered keys must be string or number
values, canonicalized consistently, and unique within the fanout group.
Duplicate fanout keys fail the fanout frame before child execution begins.

Loop iteration frames use stable iteration-index identity. A loop iteration key
is derived from the loop node path and durable iteration index, not from an
attempt-like unique id. Retrying a loop node frame clears current loop progress
and starts again at iteration `0` using the same stable iteration-index identity
scheme. Retrying a descendant leaf inside an iteration reuses the same iteration
path and creates a new attempt only. Public retry does not target structural
`loop_iteration` frames unless this goal is explicitly expanded.

### 3. Durable Scope Builder

Introduce one scope builder for arbitrary frame depth. It handles:

- workflow input and metadata;
- parent-visible node outputs;
- composite frame outputs;
- branch-local outputs;
- fanout item and item index;
- loop iteration index, previous output, and current result;
- output visibility from child scopes back to parent scopes.

The scope builder is the main correctness foundation for expression evaluation,
template rendering, task input rendering, agent prompt rendering, branch
decisions, and loop stop conditions.

Static `nodeId` remains globally unique in frozen IR, but `nodes.<id>.output`
resolves through the current frame's durable `nodeId -> dynamic key` scope map.
Lookup searches from the current frame outward to ancestors. Entering a branch,
fanout item, or loop iteration pushes local bindings. Unresolved or dynamically
ambiguous refs fail instead of guessing.

Output visibility follows a clean rule:

- completed leaf instances expose output only to their containing frame's local
  scope;
- completed author-facing composite/control `node` frames that produce a
  `NodeRef` expose their terminal `result` as that node's output in the parent
  frame scope;
- `assert` frames expose lifecycle and pass/fail state for inspection but do
  not create workflow-visible output;
- `branch`, `fanout_item`, and `loop_iteration` frame results feed their parent
  composite frame's aggregation logic and do not skip directly into ancestor
  scopes;
- parent scopes see child composite internals only through declared composite
  outputs.

Composite result aggregation is canonical:

- `if` and `switch` return the selected branch output;
- `parallel all` returns branch-keyed outputs;
- `parallel race` returns `{ winner, result }`;
- `fanout all` returns item outputs in input/index order;
- `fanout quorum` returns `{ accepted, completed }` ordered by durable
  completion/acceptance;
- `loop` returns the terminating iteration output, or the last completed output
  when the frozen exhaustion policy says to return the last result.

### 4. Recursive Materialization

Replace root-only materialization logic with a recursive transition engine. For
each runnable frame, the engine computes the next scheduler events:

- start the first child node or frame;
- continue a sequential child scope;
- decide a conditional branch;
- start parallel branch frames and group members;
- start fanout item frames and group members;
- advance or complete loop iterations;
- complete, fail, or cancel parent frames when children terminate.

The materializer stays deterministic and side-effect-free.

Every scheduler event uses a versioned scheduler envelope in `run_events`,
ordered by run sequence and written with an idempotency key when the event comes
from an operator or supervisor command. Event definitions document purpose,
payload fields, reducer effect, and replay readers. Incompatible payload
changes require a new scheduler event version or an explicit decoder.

The recursive transition engine uses one generic frame interpreter with
per-node-kind transition handlers. The interpreter owns common frame lifecycle:
scope rebuild, pause gate checks, child runnable discovery, event append
contracts, terminal propagation, cancellation boundaries, retry reopening, and
replay-visible invariants. Node-kind handlers own only local semantics:
`assert` pass/fail, `if` and `switch` branch choice, `parallel` group startup,
`fanout` item expansion, and `loop` iteration progress.

The runtime does not create separate interpreters per composite family. That
would duplicate retry, cancellation, replay, visualization, scope, and identity
rules across shapes and make nested combinations harder to reason about.

`advanceRun` drives recursive scheduler state to a deterministic fixed point
before returning. It repeatedly derives events in this order:

- control retry/reopen and lease-recovery events;
- expired attempt and signal deadline events;
- terminal propagation and group completion;
- runnable frame materialization and control decisions;
- eligible leaf attempt starts after `attempt.started` is durably committed.

Returning `idle` is invalid while any open frame or group can still derive an
event. Returning `awaiting` is valid only when no ready leaf can start and every
remaining open execution path is blocked on an open signal wait or a future
deadline. Pure control/expression evaluation does not consume leaf execution
permits.

Terminal propagation is interpreter-owned. A completed leaf exposes output only
to its containing frame. A completed author-facing composite/control `node`
frame exposes its result as that node's output in the parent frame. `branch`,
`fanout_item`, and `loop_iteration` frame results feed only their parent
composite policy. A parent frame does not complete while any required direct
child frame, child leaf instance, or group member is open. Root run terminal
status is derived only from the root frame terminal event.

### 5. Control Propagation

Extend controls from dynamic leaf instances to recursive frame trees.

Operator run-control commands are durable and idempotent by command key.
Replaying the same key returns the original accepted or rejected result and
does not re-resolve static aliases. A different key does not replace an
already-consumed signal payload, reapply a retry reset, or cancel an already
terminal subtree.

Run controls and supervisor controls are different semantic layers:

- run controls are `pause`, `resume`, `retry`, `fork`, `signal`, and `cancel`;
- supervisor controls are lifecycle controls for the detached supervisor;
- `shutdown` is a supervisor control only: it has no `runId`, does not mutate
  run state, and exits the supervisor after releasing its lease;
- the implementation MAY store run-control and supervisor-control commands in
  the same durable command table, but public types, specs, CLI wording, and
  command handlers MUST preserve the semantic distinction.

Retry semantics:

- public retry target kinds are closed: failed run, failed leaf `nodeKey`, and
  failed composite/control `frameKey`;
- structural frames such as `branch`, `fanout_item`, and `loop_iteration` are
  internal reopen targets unless this goal explicitly adds public member retry
  semantics;
- retrying a failed leaf node instance requeues that leaf and reopens its
  ancestor frame chain to runnable state;
- retrying a failed composite/control node frame re-runs that whole frame
  subtree;
- retrying an `if` or `switch` node clears the current branch decision for that
  node frame;
- retrying a `loop` node clears current loop progress and starts again at
  iteration `0`;
- retry does not delete historical scheduler events; it appends control events
  that reset the current projection for the targeted subtree;
- retry targeting can distinguish a dynamic leaf `nodeKey` from a dynamic
  composite `frameKey`, with static aliases accepted only when they resolve to
  exactly one failed dynamic target;
- completed, running, awaiting, paused, cancelled, parent-cancelled, and
  superseded targets are not retryable.

Pause and resume semantics:

- pause is a run-level durable scheduling gate, not a public frame-level
  control;
- while paused, no new scheduler-visible leaf attempt starts at any frame
  depth;
- pausing best-effort aborts every started leaf attempt and records
  `attempt.cancelled` with reason `paused`;
- a paused leaf node instance is requeued only when its ancestor frame chain is
  still non-terminal;
- pause does not terminalize frames, branch decisions, fanout items, loop
  iterations, groups, or signal waits;
- signal waits remain open while paused, but signal commands are not consumed
  until the run resumes;
- resume clears the run-level gate and lets recursive materialization continue
  from durable projection state.

Cancellation semantics:

- cancellation is structural termination of a target subtree, not a temporary
  pause;
- cancellation reasons such as `parent_failed`, `race_lost`,
  `quorum_reached`, and `operator_cancelled` propagate through the relevant
  descendant frames, leaf instances, attempts, group members, and open signal
  waits;
- cancelled subtree state is terminal and is not requeued by resume;
- the public durable command and reusable API action are named `cancel`;
- CLI/operator-facing wording can call cancellation "stop" when that better
  communicates terminal intent, but the typed command remains `cancel`;
- operator cancel targets are `run`, dynamic `frameKey`, or dynamic `nodeKey`;
- static cancel aliases are accepted only when they resolve to exactly one
  non-terminal target;
- root cancel with reason `operator_cancelled` terminalizes the run as
  `canceled`; root structural cancellation for internal reasons remains failure
  propagation;
- subtree cancel cancels descendants with reason `operator_cancelled`, then
  parent reducers apply normal composite policy.

Timeout semantics:

- task/agent attempt timeouts and signal wait timeouts are represented as
  durable deadlines;
- deadline expiry emits timeout events and fails the owning dynamic leaf unless
  the frozen node policy says otherwise;
- timeout is not ordinary cancellation for the timed-out leaf;
- cancellation reason `timeout` is reserved for descendant cleanup after a
  timed-out ancestor, if such a descendant cleanup is needed;
- completion, signal arrival, and timeout race through durable event ordering:
  the first accepted transition wins and later transitions are stale.

Signal semantics:

- signal waits belong to dynamic leaf node instances and are identified by
  dynamic `nodeKey`;
- signal commands can target a dynamic `nodeKey` directly;
- static signal `nodeId` is only an alias when it resolves to exactly one open
  signal wait in the current run;
- ambiguous static signal aliases fail and return candidate dynamic `nodeKey`
  values for operator selection;
- signal commands bind to the currently open signal wait generation for the
  target `nodeKey`;
- if that wait is consumed, timed out, cancelled, retried, or superseded before
  command application, the command is stale and does not complete a later wait;
- consuming a signal completes the targeted signal leaf instance and lets the
  ancestor frame chain continue from durable projection state.

Group cancellation semantics:

- `parallel race` succeeds on the first durably successful member;
- race member failures are tolerated until no member can still succeed;
- `fanout quorum` succeeds when the required count of successful item outputs is
  durably accepted;
- quorum accepted order follows durable completion/acceptance sequence;
- quorum fails when accepted successes plus remaining possible successes cannot
  reach quorum;
- awaiting signal members do not stop useful sibling scheduling;
- a group becomes awaiting only when no progress is possible without external
  signal input;
- `race` and `quorum` first settle the group projection by choosing the winner
  or accepted member set;
- after the group result is durable, cancellation targets only unfinished
  member subtrees inside that same group;
- `race` loser cancellation uses reason `race_lost`;
- `quorum` surplus-member cancellation uses reason `quorum_reached`;
- completed member results remain completed and failed member facts remain
  failed; cancellation does not rewrite them;
- group cancellation does not cross the current group boundary into ancestor
  frames or sibling groups.

### 6. Lease, Recovery, And Stale Work

A run has one active scheduler owner epoch. Scheduler commits, attempt starts,
attempt results, signal consumption, and recovery transitions are fenced by
active owner epoch, expected scheduler version, and idempotency key.

Attempt starts are durable-first: the scheduler records `attempt.started` before
starting external task or agent work. Attempt completion, failure, timeout
handling, and artifact writes validate current owner, current attempt, and
non-terminal instance state.

After lease expiry, a new owner supersedes started attempts from the expired
epoch before re-driving work. It requeues only leaves whose ancestor frame chain
remains non-terminal. Attempts superseded by lease recovery, retry, pause, stop,
race/quorum cancellation, or timeout do not commit accepted results or alter
ancestor/group state.

The runtime targets durable commit correctness, not exactly-once external side
effects from user tasks or agents. User task or agent side effects outside
Acpus still need idempotency at that external boundary.

### 7. Replay, Fork, And Visualization

Treat nested execution as complete only when non-execution runtime features work
against the same frame tree:

- projection rebuild from events;
- projection-table comparison;
- artifact digest and size verification;
- root output replay from recorded terminal outputs;
- fork inheritance of compatible accepted outputs and reachable artifacts;
- visualization overlays for nested frames and dynamic node instances.

Replay and recovery apply recorded scheduler facts, not live decision
recomputation. Branch decisions, fanout item key/index values, loop
iter/previous/result progress, group accepted order, and terminal frame results
are durable facts once appended.

Fork inheritance walks the dynamic tree top-down. A completed leaf or frame
result is inheritable only when its full instance path and every ancestor
decision, item key, and loop index remain compatible with the forked frozen IR
and input. Fork copies only accepted outputs and artifacts reachable from those
outputs. It does not copy active, failed, cancelled, superseded, or descendant
state from a non-inherited frame.

Work dirs, output dirs, and task/agent artifacts are keyed by dynamic leaf
`nodeKey` plus attempt-specific subpaths, never static `nodeId`. Composite
frames do not own artifact directories unless a future frame-artifact API is
explicitly introduced. Composite outputs can carry only artifact refs produced
by accepted descendant attempts.

Visualization exposes both static IR structure and a dynamic execution tree.
Dynamic display entries have stable ids, parent display ids, target kind, target
key, static node id when present, instance path, status, and group membership
references. Fanout items and loop iterations render as distinct dynamic entries
even when they share the same static node id. Visualization overlays remain
layout-free.

### 8. Capability Classification

Invalid IR shapes and malformed durable states fail with stable diagnostics or
runtime errors instead of silently idling. A capability classifier can separate:

- valid executable IR;
- invalid static IR;
- legal runtime failures;
- malformed persisted state;
- impossible scheduler invariants.

Error ownership follows three layers:

- pre-admission validation rejects invalid IR, missing references, statically
  impossible shapes, and incomplete type or output declarations before runtime
  state is mutated;
- runtime frame failure represents legal IR that fails during execution, such
  as expression errors, handler semantic errors, timeouts, assertion failures,
  and provider, task, or agent failures;
- corrupted-store and replay invariant errors represent impossible durable
  state, such as missing parent frames, terminal-state regression, or event
  history that cannot rebuild the stored projection.

The runtime must not disguise durable state corruption as workflow failure, and
admission must not reject legal runtime failures before execution.

Valid event stream plus mismatched projection is repairable only by explicit
projection rebuild tooling. Invalid scheduler envelopes, unreducible event
order, missing parent frames, terminal-state regression, or impossible
owner/attempt state are store corruption errors. Normal advance rolls back and
does not write `run.failed` for store corruption.

Replay-visible invariants include:

- exactly one root frame;
- every non-root frame has an existing parent;
- frame paths are acyclic and prefix-consistent with parent paths;
- dynamic keys map one-to-one to structured instance paths;
- branch decisions are single-assignment within a projection generation;
- fanout item identities are single-assignment within a projection generation;
- loop iteration indexes are single-assignment within a projection generation;
- terminal frame results are single-assignment within a projection generation;
- no descendant is materialized under a terminal parent;
- group members reference exactly one current member frame.

## Scheduler Model Version

The recursive runtime introduces a scheduler model/store version. Runs admitted
under the pre-recursive scheduler model are not advanced by the recursive
scheduler. Because the TypeScript core has not been published, development
stores can be cleaned up or re-admitted instead of preserving a compatibility
path. The runtime does not keep V1 and recursive materializers selectable at
runtime.

## Verification Direction

Verification grows from the lowest stable layer upward:

- unit tests for identity derivation and path round-tripping;
- unit tests for frame scope reconstruction at nested depths;
- unit tests for materialization transitions from small projections;
- integration tests for nested `if`, `switch`, `parallel`, `fanout`, and `loop`
  flows;
- integration tests for pause, resume, retry, signal, timeout, race, quorum, and
  cancellation in nested trees;
- replay tests that rebuild nested projections and root output;
- fork tests that inherit only compatible accepted outputs and reachable
  artifacts;
- visualization tests that preserve static IR structure plus dynamic nested
  runtime state.

Contract tests pin `RunDetails.dynamic`, visualization overlay shape, CLI JSON
output, and ambiguous target diagnostics for nested frames. Unit tests target
`ExecutionIdentity`, `FrameScopeBuilder`, and `FrameMaterializer` directly.
Integration tests include at least one mixed-depth workflow for each critical
crossing: `parallel` -> `fanout`, `fanout` -> `if`, `loop` -> `parallel`, and
conditional -> `loop`, plus pause/resume, retry, signal, replay, and fork
against nested targets. Root-only materialization tests should be replaced, not
layered, once the recursive module interface covers the same behavior.

## Completion Criteria

This goal is complete when Acpus has general recursive workflow scheduling:
the runtime can admit and execute arbitrary valid `WorkflowIR` combinations at
any nesting depth supported by the IR schema, and the durable runtime features
that make execution trustworthy still work: recovery, replay, retry, signal,
pause/resume, operator `cancel`, fork, artifacts, and inspection.

Representative smoke workflows are useful for validation, but they are not the
definition of completeness. Completeness is the common recursive state machine
model applying uniformly to root scopes, nested composite scopes, and leaf
instances.

As implementation lands, the current runtime and CLI specs are updated in the
same changes to describe the new behavior and remove the V1 unsupported-shape
boundary.
