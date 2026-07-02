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

## Rationale

This model matches the existing fork direction better than a full global cache model. Current fork already treats frozen source run data, replacement workflow, input override, agent override inheritance, and artifact verification as the durable boundary. The missing piece is that inherited completed results are currently copied into public run/node projection rows, while scheduler execution resumes from scheduler events.

Therefore, the desired feature does not require discarding the current fork concept. It requires adding a scheduler-visible seed plan for compatible completed prerequisites.

## Terminology

- Source run: the old run being forked.
- Replacement workflow: the fixed workflow supplied at fork time.
- Target: the replacement-workflow node or dynamic scheduler target selected as the recovery point for the new run.
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

Target omission is supported only as a convenience rule. If `--target` is omitted and the source run has exactly one failed scheduler target that resolves unambiguously to a compatible same-id target in the replacement workflow, fork may use that target. If resolution is missing, ambiguous, or incompatible, fork must fail before creating the new run and ask for an explicit `--target`.

Rejected alternative: making `--target` point at the source run's failed node. That model would require an extra old-target-to-new-target mapping whenever the fixed workflow changes shape, and it makes replacement fork look too much like retrying the old failed node.

### 2. Compatibility Rules

Status: decided

Compatibility must be stronger than same node id, but it should not require the entire workflow or entire composite subtree to be unchanged.

The initial compatibility rule is intentionally conservative:

- Fork with changed `--input` does not reuse completed source-run node outputs.
- A reused leaf node must have the same node id and the same full node IR signature.
- A reused composite/control node should use a shallow control signature rather than the full subtree signature, so fixing a child node does not invalidate reusable completed siblings or inner descendants.
- Only the root-to-target control path and the root-to-reused-node control path must be compatible. Unrelated siblings, downstream nodes, and branches outside the reusable prerequisite closure do not block reuse.
- Effective agent override compatibility is checked only for reused agent nodes and only for the agent key used by that node. Changing unrelated agent overrides does not block reuse.
- Reused outputs must be scheduler-accepted completed facts. Failed, running, awaiting, cancelled, superseded, and active attempt facts are never compatible.

Composite internals must remain reusable at their own dynamic identity granularity. A composite is not treated as a single all-or-nothing cache boundary. A completed child inside a composite can be reused when both the child fact and the control context that produced its dynamic instance are compatible:

- `if` and `switch` reuse requires the same selected branch for the reused node path.
- `parallel` reuse requires the same branch id and compatible parallel strategy for the reused branch path.
- `fanout` reuse requires the same fanout control signature and the same normalized item key for each reused item instance.
- `loop` reuse requires the same loop control signature, iteration index, and previous-value chain up to the reused iteration.
- Nested composites compose these rules through the full parent frame/member chain. Matching an inner node id alone is not enough.

This keeps composite reuse precise enough to run correctly while still allowing localized workflow fixes inside composite bodies.

### 3. Seed Plan

Status: open

Define how reusable completed facts are converted into scheduler-visible state for the new run. This is the core gap in the current implementation.

### 4. Artifact Reuse

Status: partially decided

Reuse only artifacts reachable from inherited accepted outputs. Artifact ids and artifact URIs must be rewritten for the new run, and copied files must be verified by digest and size.

### 5. CLI And Runtime API

Status: open

Likely user-facing shape:

```bash
acpus runs fork <run-id> --workflow <fixed.workflow.ts> --target <run-target>
```

The runtime command payload will need a typed target field for fork, without weakening existing durable command validation.

### 6. Failure Reporting

Status: open

When targeted replacement fork cannot seed the target safely, it should fail before admitting a misleading runnable run. Diagnostics should explain which prerequisite or compatibility check blocked reuse.

### 7. Tests

Status: open

Tests should cover linear reuse, incompatible changed nodes, replacement workflow target recovery, artifact URI rewriting, dynamic target ambiguity, and no inheritance of active/failed/superseded scheduler state.

## Design Principle

Targeted replacement fork should be a new fork mode built on the current durable fork boundary, not a rewrite of all fork behavior. Existing run-level fork semantics should remain available.
