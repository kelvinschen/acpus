# Add an `awaiting` node state for human-in-the-loop Approval Gates

> Superseded by [0010](0010-signal-node-supersedes-approval-gate.md): the `awaiting` state and in-memory decision channel decided here are retained, but the Approval Gate built on them is replaced by a general Signal Node. Read this ADR for why `awaiting` exists; read 0010 for the current node.

To make Approval Gates a real human-in-the-loop primitive, we added a 7th node state, `awaiting`, rather than reusing `running` or `paused`. A Gate enters `awaiting` while blocked on a human decision; an approve/reject decision (delivered through the Run Supervisor `signal` channel into an in-memory resolver) resolves it to `completed`, and an operator cancel takes it to `cancelled`.

## Considered Options

- Reuse `running` with an in-memory pending promise (no state-machine change; UI cannot distinguish "executing" from "waiting on a human").
- Reuse `paused` + a decision-carrying resume (violates the spec requirement that Approval Gates be distinct from operator pause; operator resume would mis-trigger approval).
- Add a 7th state `awaiting` (chosen).

## Decision

`awaiting` is a first-class node state with transitions `running → awaiting` and `awaiting → {completed, cancelled}`. The decision channel is in-memory (`approvalResolvers`), consistent with how `abortControllers`/`abortIntents` already work; the `signal` endpoint requires a live interpreter, like `pause`/`cancel`.

## Consequences

- The node state machine is a core contract: this is hard to reverse and touches every state enumeration point (theme, model counts, CLI observations, supervisor recovery), all updated together.
- The in-memory channel does not survive a supervisor restart: an `awaiting` node is reset to `pending` on recovery and re-awaits a fresh decision. Durable decision recovery is deferred (see roadmap), mirroring the deferred `escalate` channel.
- A Gate with no `timeout` waits indefinitely for a human decision; the run stays `running`, which naturally keeps the supervisor alive (no extra keepalive code needed).
