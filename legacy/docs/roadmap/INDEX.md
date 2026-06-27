# Acpus Roadmap Index

This directory tracks Acpus future plans, backlog, and capability gaps. Current implemented behavior lives in `specs/` and is not repeated here. Completed roadmap records live in `docs/archive/`.

## Writing Conventions

- Write only future plans, planned work, and capability gaps. Implemented behavior belongs in `specs/`; the roadmap only points to unfinished work.
- Do not use RFC 2119 normative verbs (MUST/SHOULD/MAY) as constraints — those are reserved for specs. Use descriptive wording such as "plan", "goal", "gap", "candidate", and "TBD" here.
- Keep terminology aligned with `CONTEXT.md`: Workflow Spec, Run, Node, Composite Node, Executable Node, Agent Step, Program Step, Signal Node, Node Key, Node State Machine, Daemon, Artifact; also keep the PRD/README terms frozen IR and acpx-managed session.
- Do not violate locked architecture decisions: ADR 0001 (`@acpus/core` stays side-effect-free; I/O and process concerns belong to runtime/CLI), ADR 0002 (M1 uses tsc builds; bundling is only a future publishing optimization).
- Do not introduce distributed-system assumptions: Acpus is a single-host local CLI tool. Temporal was only considered as an implementation kernel. The distributed/service-first legacy designs in `docs/archive/` are historical and are not current truth.

## Archived Milestones

The original PRD milestone track has landed or been explicitly scoped down. Historical completion records:

| Milestone | Theme | PRD mapping | Record |
|---|---|---|---|
| R1 | Close runtime primitive gaps (M2/M3 leftovers) | M2 / M3 | [docs/archive/R1-runtime-primitive-gaps.md](../archive/R1-runtime-primitive-gaps.md) |
| R2 | Integrate Agent Activity with real acpx | M4 | [docs/archive/R2-agent-acpx-integration.md](../archive/R2-agent-acpx-integration.md) |
| R3 | Close durable control and replay work | M5 | [docs/archive/R3-durable-controls-and-replay.md](../archive/R3-durable-controls-and-replay.md) |
| R4 | Converge the real-agent path (thin scope) | M6 | [docs/archive/R4-real-agent-compat-matrix.md](../archive/R4-real-agent-compat-matrix.md) |
| Design | Explicit `pipeline` and unified `do` semantics | M1 design cleanup | [docs/archive/pipeline-and-do-design.md](../archive/pipeline-and-do-design.md) |

## Backlog / Capability Gaps

### Signal decision durable recovery

The current Signal Node decision channel is an in-memory resolver. If the Run Supervisor restarts while a Signal Node is `awaiting`, the node is reset to `pending` and waits for an external decision again; payloads arriving during the downtime window are lost.

Candidate direction: persist pending decisions and resolver state as part of durable recovery for the whole `awaiting` family, not as a Signal-only special case. See ADR 0010 Option A.

### Forked Run checkpoint write concurrency safety (F3)

`RunStore.appendCheckpoint` is read-modify-write. Concurrent checkpoint writes from multiple processes in the same Workspace can lose entries. The current supervisor lock rules out concurrency on most paths, but this can reappear if CLI subprocesses append directly in the future.

Candidate directions: file lock around checkpoint mutation, or replace the checkpoint index with an append-only journal plus compaction/read projection.

### Forked Run inheritance across subworkflow boundaries (F4)

The fork planner indexes only the parent frozen IR. Subworkflow child IRs are compiled at runtime, so the first checkpoint inside a subworkflow can be classified as `missing-in-new-spec` and truncate inheritance.

Candidate direction: have the fork planner compile referenced subworkflows in advance through `compileWorkflow` + `includeResolver`, then include their child IRs in the inheritance index with the same node-key prefixing used by runtime execution.

### Forked Run topological-order inheritance (F10)

`planForkedRun` currently performs linear truncation by checkpoint write order (terminal completion time). When parallel/fanout siblings complete out of order, an actually inheritable sibling can be truncated. This is under-inheritance — semantically safe but conservative — not incorrect inheritance.

Candidate direction: walk the new IR in topological/control-flow order and decide inheritance per Node. This requires the fork planner to reproduce enough interpreter control-flow inference to understand parallel/fanout/switch/loop structure.

### Replay and history enhancements

Current replay is a read-only topology check: it re-walks the frozen IR, feeds recorded outputs back into the expression context, and compares the reached Node Key set against persisted state. It does not reconstruct a full transition history or verify every per-node output byte-for-byte.

Candidate enhancements, if needed by debugging/audit workflows:

- append-only event-sourced Run history for state transitions;
- per-node terminal state and output equivalence checks;
- replay bundle export for offline debugging;
- stricter execution-clock alignment where `now()`-derived control flow must be replayed byte-for-byte.
