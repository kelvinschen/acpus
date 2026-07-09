# Targeted Replacement Fork Goal

Date: 2026-07-02

## Purpose

Define the intended direction for extending Acpus fork semantics so an operator can recover from a failed run by fixing the workflow and creating a new run that reuses compatible completed prerequisite work.

This is a working goal and decision log. As each major design module is settled, update this document so later design work does not lose the agreed context.

## Current Decision

We will pursue the "compatible completed prerequisite closure" model.

For a failed old run and a fixed replacement workflow, the new forked run should reuse only the old run results that are:

- completed and accepted by the scheduler,
- still present and compatible in the replacement workflow,
- required to make the selected target node runnable in the replacement workflow.

The target node and its downstream work should execute in the new run. Failed, running, awaiting, cancelled, superseded, and active scheduler state should not be inherited.

If no target is supplied, the effective target is replacement workflow root completion. In a linear workflow this behaves like targeting the final node, but the formal model is root frame completion rather than "last node" or output-expression-only dependency because parallel, fanout, loop, side-effecting intermediate nodes, and multi-output workflows do not always have a single final node.

Targeted replacement fork must support failed source runs. This is the core recovery use case: an operator fixes the workflow and forks from the failed run, reusing only scheduler-accepted completed facts.

## Rationale

This model matches the existing fork direction better than a full global cache model. Current fork already treats frozen source run data, replacement workflow, input override, agent override inheritance, and artifact verification as the durable boundary. The missing piece is that inherited completed results are currently copied into public run/node projection rows, while scheduler execution resumes from scheduler events.

Therefore, the desired feature does not require discarding the current fork concept. It requires adding a scheduler-visible seed plan for compatible completed prerequisites.

## Terminology

- Source run: the old run being forked.
- Replacement workflow: the fixed workflow supplied at fork time.
- Target: the replacement-workflow node or dynamic scheduler target selected as the recovery point for the new run.
- Root completion target: the implicit target used when no explicit target is supplied; it means the new run should complete the replacement workflow root frame while reusing compatible completed prerequisites.
- Compatible completed prerequisite closure: the completed source-run scheduler facts that are required by the target in the replacement workflow and still match the replacement workflow structure.
- Seeded facts: inherited completed scheduler facts written into the new run so runtime advancement can consume them as execution state.

## Confirmed Semantics

For a linear workflow:

```text
Old: A -> B -> C(failed)
New: A -> X -> Y
```

If the target is `Y`, only `A` is reusable when `A` is completed and compatible. `B` and `C` do not exist in the new workflow and cannot be reused. `X` and `Y` must run in the new run.

For:

```text
Old: A -> B -> C(failed)
New: A -> B -> Y
```

If `A` and `B` remain compatible and completed, both can be reused; `Y` runs.

If `B` changed incompatibly, only `A` can be reused.

## Non-Goals

- Do not resume the old failed run with a different workflow.
- Do not inherit active frames, running attempts, signal waits, or failed attempt state.
- Do not maximize reuse across unrelated branches as the primary goal.
- Do not treat matching node names alone as sufficient compatibility.
- Do not add legacy compatibility shims for old workflow models.

## Major Design Modules

### 1. Target Selection

Status: decided

The fork target identifies the recovery target in the replacement workflow, not the failed node in the source run.

Primary user-facing shape:

```bash
acpus runs fork <source-run-id> --workflow <fixed.workflow.ts> --target <replacement-target>
```

For a replacement workflow, `<replacement-target>` means "make this target runnable by seeding compatible completed prerequisites from the source run, then execute the target and its downstream work in the new run." This allows the fixed workflow to rename, split, merge, or replace the failed source node without requiring a source-to-replacement target mapping.

Target omission is supported as the default recovery mode. If `--target` is omitted, fork uses the root completion target: it seeds compatible completed prerequisites that are needed to complete the replacement workflow root frame, then lets the scheduler execute all unseeded required work.

This can be understood as "target the final node" only for simple linear workflows. The implementation should not encode a last-node rule and should not reduce the target to public output expression dependencies. It should target root frame completion so workflows with multiple terminal branches, parallel branches, fanout items, loops, side-effecting intermediate nodes, or output expressions have a coherent default.

Explicit dynamic targets are supported only when they resolve unambiguously to one replacement-workflow dynamic identity. If a static target inside fanout/loop/parallel expansion would produce multiple possible dynamic instances and the command cannot resolve exactly one target, fork must fail before creating the new run and ask for a more explicit `--target`.

Rejected alternative: making `--target` point at the source run's failed node. That model would require an extra old-target-to-new-target mapping whenever the fixed workflow changes shape, and it makes replacement fork look too much like retrying the old failed node.

### 2. Compatibility Rules

Status: decided

Compatibility must be stronger than same node id, but it should not require the entire workflow or entire composite subtree to be unchanged.

The initial compatibility rule is intentionally conservative:

- Fork with changed `--input` does not reuse completed source-run node outputs.
- A reused leaf node must have the same node id and the same canonical semantic leaf signature.
- A reused composite/control node should use a shallow control signature rather than the full subtree signature, so fixing a child node does not invalidate reusable completed siblings or inner descendants.
- Only the root-to-target control path and the root-to-reused-node control path must be compatible. Unrelated siblings, downstream nodes, and branches outside the reusable prerequisite closure do not block reuse.
- Effective agent override compatibility is checked only for reused agent nodes and only for the agent key used by that node. Changing unrelated agent overrides does not block reuse.
- Reused outputs must be scheduler-accepted completed facts. Failed, running, awaiting, cancelled, superseded, and active attempt facts are never compatible.
- Compatibility signatures should use canonical semantic node data. They must exclude non-semantic metadata such as source locations, diagnostics, generated timestamps, run ids, artifact ids, and attempt ids.
- Leaf node signatures include the node's semantic IR fields, including `id`, `kind`, schema, `run`, timeout, and retry settings when those fields exist.
- Reusable module task nodes do not require extra provenance beyond the recorded IR. If the recorded module task information aligns under the canonical signature rule, the node may be reused.
- For reusable module task nodes, the recorded module target fields such as `specifier`, `exportName`, and `referrer.path` are sufficient compatibility inputs. No extra task source provenance is required.
- Agent node canonical signatures are compared after applying the effective fork agent override for the agent key used by that node.
- Composite/control node signatures are shallow and include control semantics, not child subtrees:
  - `if` and `switch`: condition expressions, case order, and default/branch shape.
  - `parallel`: strategy, max concurrency, and branch ids.
  - `fanout`: `over`, `key`, strategy, count, and max concurrency.
  - `loop`: initial `state` and transition/body output semantics.

Operator-requested unsafe reuse is an explicit exception to the conservative
signature rule. When `unsafeReuse` / `--unsafe-reuse` is supplied, seed planning
may reuse scheduler-accepted completed facts despite changed input or
source/replacement semantic signature mismatch. This mode is intentionally
dangerous and exists for cases where the operator accepts that old completed
outputs remain valid while later replacement workflow definitions should run.
It must still preserve target prerequisite closure, must not seed the explicit
target itself, and must not inherit failed, active, cancelled, superseded, or
awaiting state.

Composite internals must remain reusable at their own dynamic identity granularity. A composite is not treated as a single all-or-nothing cache boundary. A completed child inside a composite can be reused when both the child fact and the control context that produced its dynamic instance are compatible:

- `if` and `switch` reuse requires the same selected branch for the reused node path.
- `parallel` reuse requires the same branch id and compatible parallel strategy for the reused branch path.
- `fanout` reuse requires the same fanout control signature and the same normalized item key for each reused item instance.
- `loop` reuse requires the same loop control signature, iteration index, and previous-value chain up to the reused iteration.
- Nested composites compose these rules through the full parent frame/member chain. Matching an inner node id alone is not enough.

This keeps composite reuse precise enough to run correctly while still allowing localized workflow fixes inside composite bodies.

### 3. Seed Plan

Status: decided

Seed planning should be implemented as a pure scheduler-facing helper, likely under `packages/runtime/src/scheduler/fork-seed.ts`, with a small interface shaped around:

- source scheduler projection and source frozen workflow,
- replacement workflow, replacement input, and effective fork agent overrides,
- explicit target or implicit root completion target,
- source-to-fork artifact id rewriting.

The helper should return a typed seed plan containing scheduler seed events, inherited node keys, and any artifact rewrite requirements. It should return typed seed-plan failures for recoverable target or compatibility problems instead of throwing for ordinary user-correctable failures.

Seeded facts should be represented as a valid scheduler event prefix for the new run. Do not write scheduler projection tables directly and do not invent a separate public-only inheritance path. The seed prefix should use existing scheduler event vocabulary such as `frame.started`, `branch.decided`, `group.started`, `group.member_ready`, `group.member_completed`, `group.completed`, `frame.loop_advanced`, `frame.completed`, `instance.ready`, and `instance.completed`.

The seed prefix must be complete enough for scheduler reducers to accept it from an empty fork scheduler projection. A terminal fact must not appear before the object it terminalizes exists: for example, `instance.completed` requires prior `instance.ready`, `frame.completed` requires prior `frame.started`, `group.member_completed` requires prior `group.started` and `group.member_ready`, `branch.decided` requires the corresponding node frame, and loop state must start at iteration 0 and preserve the previous/result chain without gaps.

Seed planning should rebuild the prefix against the replacement workflow topology rather than copying arbitrary source scheduler events. It should recompute replacement scope maps and reconstruct the control context needed by materialization: root frame, ancestor frames for the target and reused facts, conditional decisions, group/member rows, fanout item payload and identity, and loop frame/iteration state where applicable.

Do not create fake `attempt.started` or `attempt.completed` events for inherited work. Attempts represent scheduler-visible execution performed by the new run. Inherited facts should make completed prerequisites visible to materialization, but they should not claim that the forked run executed the old attempts.

The target itself and its downstream work must not be seeded. With an explicit target, only strict compatible prerequisites are eligible. With the implicit root completion target, all compatible completed facts required for replacement workflow root completion are eligible; incompatible or missing required work remains unseeded and will execute in the new run.

Composite/control completion may be seeded, but only when the compatible child facts needed to justify that completion are also seeded or already represented in the seed prefix. Control seed events must not skip replacement-workflow work that still needs to execute.

For explicit targets inside composites, ancestor control frames on the target path may seed context events such as started frames, branch decisions, groups, and member readiness, but they must not seed terminal completion events that would make the target subtree look already completed. This prevents seeding a parent composite from bypassing the target's required execution.

The current `forkRun` durable boundary remains the right owning seam for persistence, artifact copy/verification, run rows, and command completion. Seed planning should be called from `forkRun`; scheduler control commands should not own replacement-fork semantics.

### 4. Artifact Reuse

Status: decided

Reuse only artifacts reachable from inherited accepted outputs selected by the seed plan. Artifact ids and artifact URIs must be rewritten for the new run, copied files must be verified by digest and size, and artifacts from unseeded, failed, cancelled, superseded, running, or awaiting work must not be inherited.

Inherited artifacts should not imply fork-local scheduler attempts. If artifact rows or paths retain source attempt-shaped metadata, that metadata must be treated as inherited provenance and must not be used as evidence that the forked run executed a scheduler attempt.

### 5. CLI And Runtime API

Status: decided

Likely user-facing shape:

```bash
acpus runs fork <run-id> --workflow <fixed.workflow.ts> --target <run-target>
```

The runtime command payload needs a typed optional `target` field for fork, without weakening existing durable command validation. The field must flow through CLI parsing, `RuntimeMutationInput`, durable command payload validation, `applyControlCommand`, and `forkRun` options.

Omitting `--target` is valid and means the implicit root completion target. Passing an empty string should not create a distinct target; CLI parsing should either treat it as invalid usage or normalize it to omission before durable command admission.

Fork mode selection is explicit:

- `acpus runs fork <run-id>` without replacement workflow, replacement input, agent overrides, or target keeps the existing non-targeted run-level fork semantics.
- Supplying replacement workflow, replacement input, agent overrides, or an explicit target selects targeted replacement fork semantics.
- In targeted replacement fork mode, omitting `--target` means the implicit root completion target.
- Failed source runs are valid for targeted replacement fork; this is the intended recovery path for fixing failed work and continuing from compatible completed prerequisites.

### 6. Failure Reporting

Status: decided

When targeted replacement fork cannot seed the target safely, it should fail before admitting a misleading runnable run. Diagnostics should explain which target, prerequisite, dynamic identity, artifact rewrite, or compatibility check blocked reuse.

Incompatible completed prerequisites are not necessarily fatal for the implicit root completion target or for explicit targets when the replacement workflow can execute the missing prerequisite normally. They should simply remain unseeded. Failures should be reserved for cases where the requested target cannot be resolved safely, the replacement control path cannot be reconstructed, or an inherited artifact/output reference cannot be rewritten consistently.

Seed planning should expose typed failures that runtime use cases and durable command failure payloads can preserve. CLI output should render the message from those typed failures rather than parsing exception strings.

Durable command failure payloads should preserve stable machine-readable tags for seed-plan failures such as target resolution failure, dynamic target ambiguity, compatibility failure, replacement control-path reconstruction failure, and artifact rewrite failure.

### 7. Source Run Eligibility

Status: decided

Targeted replacement fork must allow failed source runs. This is not an edge case; it is the primary recovery path.

Only scheduler-accepted completed facts from the source run are eligible for seeding. Failed, running, awaiting, cancelled, superseded, and active scheduler state remain non-inheritable regardless of the source run's public status.

Existing run-level fork semantics should remain available for non-targeted forks.

### 8. Store Integration

Status: decided

This exists to keep fork admission, scheduler-visible inherited facts, artifacts, and public projections atomic and consistent. The current `forkRun` path writes inherited completion mostly through public `node_states`, while scheduler execution rebuilds state from scheduler events in `run_events`. Targeted replacement fork must not create a run that looks inherited in public projections while the scheduler still sees an empty run.

Seed events should be inserted as fork-admission initialization, not as a normal scheduler owner commit. The current scheduler append path opens its own transaction and requires an active owner epoch, so `forkRun` likely needs an internal transaction-local helper that:

- validates the seed prefix by applying it to `createSchedulerProjection(forkRunId)`,
- inserts a scheduler commit record for idempotency and digest tracking,
- inserts the scheduler event envelopes into `run_events` using the fork run's sequence order,
- syncs scheduler projection tables and public projection rows before committing the fork.

This helper should be private to the store implementation unless a second caller appears. It should not add methods to `RuntimeStore` or `SchedulerStorePort`, and it should not require a synthetic scheduler owner. The expected added complexity is localized store plumbing plus focused integration tests, not a new public persistence abstraction.

### 9. Target Grammar

Status: decided

The first implementation should use a conservative target grammar:

- a static node id target is allowed only when it resolves to one replacement-workflow static target that cannot expand into multiple dynamic instances for the requested target,
- a target inside fanout, loop, or parallel dynamic expansion must use a dynamic `nodeKey` or a structured instance path once static resolution would be ambiguous,
- fanout and loop aliases that could produce zero, one, or many instances must fail before creating the fork unless the replacement input plus seeded control path can prove exactly one dynamic identity,
- omitted target remains the root completion target and does not use this static-alias ambiguity rule.

### 10. Tests

Status: decided

Tests should stay focused at the lowest stable layer that covers each risk.

Reducer-level tests should cover accepted and rejected seed prefixes by applying events to `applySchedulerEvents(createSchedulerProjection(...))`, with leaf, branch, parallel/group, fanout, and loop cases.

Seed planner unit tests should cover closure selection and compatibility rules: changed input does not reuse completed outputs, target and downstream work are not seeded, failed/active/cancelled/superseded state is not inherited, effective agent override compatibility only affects the matching agent node, and omitted target means root completion target.

Store/runtime integration tests should cover failed-source recovery, inherited facts visible through scheduler snapshots, artifact id and URI rewriting from seeded outputs, no fake attempts for seeded facts, rollback when seed admission fails, changed incompatible nodes not reused, and fork mode separation between targeted replacement fork and existing non-targeted run-level fork.

CLI and durable-command tests should stay thin: target field parsing and propagation, empty target handling, and preservation of typed seed failure tags in command failure payloads.

## Design Principle

Targeted replacement fork should be a new fork mode built on the current durable fork boundary, not a rewrite of all fork behavior. Existing run-level fork semantics should remain available.

## Implementation Status

Status: accepted first implementation implemented

Implemented in this pass:

- CLI/runtime/durable command plumbing for optional fork `target`.
- CLI/runtime/durable command plumbing for explicit unsafe reuse via `--unsafe-reuse`.
- Empty fork target validation at CLI/runtime/durable payload boundaries.
- Fork mode selection where replacement workflow, input override, agent override, or explicit target selects targeted replacement fork behavior.
- Unsafe reuse mode selects targeted replacement fork behavior and may seed completed prerequisites despite changed input or semantic signature mismatch.
- Scheduler-visible seed planning in `packages/runtime/src/scheduler/fork-seed.ts`.
- Fork admission insertion of scheduler seed events in the same store transaction as the fork run, without synthetic scheduler ownership.
- No fake fork-local attempts for inherited scheduler facts.
- Failed source run recovery for compatible completed root prerequisites.
- Explicit leaf target is not seeded even when source completed it.
- Static explicit leaf targets seed only workflow-order prerequisite leaf paths, including branch-local prerequisites, not unrelated sibling work.
- Leaf reuse compatibility includes ancestor control context signatures and branch path identity for statically resolvable paths.
- Dynamic explicit targets resolve through source scheduler paths or replacement materialization, then seed only compatible prerequisites on the proven replacement path.
- Dynamic fanout targets seed same-item prerequisites without seeding sibling item work.
- Dynamic loop targets seed prior compatible iterations and same-iteration prerequisites needed to reach the requested iteration target.
- Static composite/control targets are supported as subtree execution targets; seed planning inherits only compatible work before the target node and does not seed completed work inside the target subtree.
- Static targets inside fanout/loop expansion are supported only when replacement materialization proves exactly one dynamic target instance; ambiguous fanout aliases and repeating loop aliases still require a dynamic `nodeKey`.
- Static targets after `all` fanout prerequisites can seed compatible fanout item work before the target.
- `race` parallel can reuse only the accepted winning branch for implicit root-completion recovery.
- `quorum` fanout can reuse only accepted members for implicit root-completion recovery when the accepted member order is stable against replacement materialization order.
- Artifact URI rewriting for seeded scheduler payloads is covered by a low-level artifact rewrite unit test.
- Artifact reachability for targeted fork includes actual seed-plan event payloads, not only public node projection rows.
- Artifact rewrite failures are surfaced as typed seed-plan failures instead of generic unhandled errors.
- Store transaction rollback for seed admission failure is covered by a targeted fork integration test that verifies run rows, scheduler commits, and fork directories do not leak.
- Replacement seed materialization uses the fork replacement input and meta scope, matching normal runtime advancement.
- Changed fork input disables inherited completed facts while still initializing replacement scheduler materialization.
- Dynamic target existence and stale-path checks against replacement materialization.
- Static targets on unselected conditional paths fail before fork creation instead of admitting a fork whose target cannot execute.
- Static targets also use replacement path-possibility checks, so unselected control paths fail even when unrelated work remains ready.
- Explicit targets fail when replacement materialization reaches a terminal state that proves the target cannot execute.
- Typed seed-plan failure tags preserved in durable command failure payloads.
- Specs updated for `runs fork --target` and targeted fork seed behavior.

Validated by focused tests:

- `packages/runtime/test/fork-seed.unit.test.ts`
- `packages/runtime/test/runtime-supervisor.integration.test.ts`
- `packages/runtime/test/scheduler-node-executor.integration.test.ts`
- `packages/cli/test/runs-inspect.e2e.test.ts` for empty fork target usage handling

## Deferred Enhancements

These are known conservative limits of the accepted first implementation.

- `race` and `quorum` prerequisite reuse before an explicit downstream target remains conservative; the fork can still execute the required group work in the forked run.
- `quorum` reuse is skipped when the source accepted member order differs from replacement natural materialization order. Full arbitrary-order quorum reuse would require seed planning to reconstruct accepted member completion order explicitly.
