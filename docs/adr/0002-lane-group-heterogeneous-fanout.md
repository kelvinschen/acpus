# Superseded Heterogeneous Fanout Design

Status: superseded by ADR 0006 follow-up fanout lane filter simplification

## Decision

This ADR previously proposed a grouped fanout lane selection model. That design is no longer current.

Current fanout truth is maintained in `specs/workflow-spec.md`:

- Fanout uses top-level `lanes[]`.
- Every lane runs by default.
- `when` filters individual lanes.
- If multiple lane conditions are true, all matching lanes run.
- There is no built-in one-of selection, lane default, or group dimension.

## Consequences

This historical ADR MUST NOT be used as implementation guidance. Runtime identity, run-index state, monitor tasks, output paths, and session keys use only stage id, item id, and lane id for fanout lane work.
