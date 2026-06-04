# ADR 0007: Agent Task Retry Unification

## Status

Accepted

## Context

Agent work previously had separate paths for runtime retries, stale recovery, schema-aware output repair, and public diagnose artifacts. Those paths produced different attempt identities, accounting fields, prompts, and CLI/status surfaces even though they all represented follow-up handling after an Agent Work Unit failed to produce a usable terminal result.

The schema repair path was especially misleading: output parse/schema failures often came from interrupted or rate-limited agent turns, not from a completed task that only needed JSON rewriting. A repair prompt that focused on candidates and schema errors could ask the agent to format an answer before the task was actually complete.

## Decision

Use one **Agent Task Retry** engine for follow-up agent calls on the same Agent Work Unit.

- Retry reasons are `runtime`, `stale`, and `continuation`.
- Each Agent Work Unit has a fixed retry budget of 2; the maximum number of agent calls per work unit is 3.
- Attempts are always monotonic `attempt-1`, `attempt-2`, and `attempt-3`.
- Output parse/schema failures use `continuation` retry instead of schema repair.
- Continuation prompts reuse the same session key and include only a short continue instruction, the previous failure code, and the final Output Contract.
- Retry exhaustion blocks with `AGENT_TASK_RETRY_EXHAUSTED` while preserving retry history and last failure code.
- Public `acpus diagnose`, `diagnosed_blocked`, and diagnostic attempt artifacts are removed. `RunDiagnosticsView` remains an internal read-only projection for tests and troubleshooting helpers.

## Consequences

The runtime has one canonical retry budget, one attempt identity model, and one accounting model. There is no repair alias, repair attempt directory, diagnostic attempt directory, fallback output adapter, or public diagnose status. Existing run directories using the old shapes are not supported inputs.
