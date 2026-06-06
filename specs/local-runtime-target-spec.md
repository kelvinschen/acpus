# Local Runtime Target Spec

## Purpose

Acpus runtime execution is a local CLI orchestration boundary for durable single-host workflows that run local ACP agents and local programs. The runtime executes the frozen IR produced by the compiler, persists per-node state for crash recovery, and exposes a daemon REST API for run control.

## Requirements

### Execution Boundary

- The runtime MUST execute as a local CLI tool on a single host.
- The runtime MUST schedule Workflow Nodes through a local durable execution engine.
- The runtime MUST run Agent Steps against local ACP-compatible agents through acpx.
- The runtime MUST delegate ACP session lifecycle, queue ownership, session loading, session resumption, and cooperative session cancellation to acpx.
- The runtime MUST run Program Steps as local subprocesses on the same host.
- The runtime MUST NOT provide distributed execution across multiple hosts.
- The runtime MUST NOT route Agent Steps or Program Steps to remote workers.
- The runtime MUST NOT require a shared Temporal cluster for normal operation.
- The runtime MUST NOT require cross-host workspace transfer, remote task queues, or worker affinity.
- The runtime MUST treat acpx as the local ACP session scheduler, not as the Workflow scheduler.
- The runtime MUST treat Acpus as the Workflow scheduler and the source of Node state, retry, timeout, pause, resume, cancel, and artifact-reference decisions.

### Node State Machine

- Every Node in a Run MUST follow a unified 6-state business lifecycle: `pending → running → {completed, failed, paused, cancelled}`.
- A `paused` Node MUST be resumable (a `paused → running` lifecycle transition).
- `completed`, `failed`, and `cancelled` MUST be terminal in the business lifecycle: they MUST NOT have any outgoing lifecycle transition, and `canTransition`/`transition` MUST reject moving out of them.
- Recovery from a terminal or stale state MUST be modeled as an explicit control-plane reset, not as a business-lifecycle transition: operator retry MAY reset a `failed` Node to `pending`, and crash recovery MAY reset a stale `running` Node to `pending`. These resets MUST be exposed only through dedicated operations, never through the generic transition API.
- `completed` and `cancelled` MUST NOT be resettable by any control-plane operation.
- The runtime MUST persist every state change to disk immediately.

### State Persistence

- The runtime MUST persist per-node state as individual JSON files with atomic write (temp file + rename) for crash safety.
- The runtime MUST persist run-level metadata (run ID, workflow name, status, IR digest, input digest) separately from node state.
- The runtime MUST persist a frozen IR snapshot at run creation and MUST NOT re-read mutable YAML during replay or resume.
- The runtime MUST persist, for each executable leaf Node, a snapshot of its parent dynamic value-context (fanout item, loop round) so resume and retry can rebuild the expression context without re-deriving ancestor scopes; the snapshot MUST contain only value context, never large artifact payloads.
- The runtime MUST write node keys as filesystem-safe filenames by replacing `/` with `:`.

### Node Keys

- The runtime MUST resolve each Node's `NodeKeyTemplate` plus runtime dynamic context (loop round, fanout item ID, lane ID, parallel branch ID) into a stable key string.
- Node keys MUST always include dynamic dimensions from ancestor scopes, even when the node itself does not use that dimension, to ensure unique keys for nested nodes.
- Node keys MUST use the encoding `workflow/mapped/item:file-a/lane:0` where dynamic dimensions appear as `type:value` suffix segments.

### Expression Evaluation

- The runtime MUST evaluate `${{ ... }}` expression templates at runtime using a CEL evaluator.
- The runtime MUST rewrite `loop.` references to `loop_ctx.` before evaluation.
- The runtime MUST register custom functions: `now()`, `len()`, `startsWith()`, `matches()`, `coalesce()`.
- `now()` MUST return a deterministic timestamp, not wall-clock time.

### Concurrency

- The runtime MUST use cooperative single-event-loop concurrency (Promise.all/Promise.race).
- The runtime MUST use `p-limit` to cap concurrency for fanout and parallel nodes.
- Fanout lanes MUST receive fresh shallow copies of the steps context to prevent data races.
- A `race` wait strategy MUST NOT cancel losing branches/lanes; their settled results MUST be consumed to avoid unhandled rejections.

### Executors

- The runtime MUST support mock executor adapters for testing (MockAgentExecutor, MockProgramExecutor).
- The runtime MUST support a real ProgramExecutor using `execa` for local subprocess execution.
- The runtime MUST support a real AgentExecutor spawning `acpx` via `execa` for ACP session management.
- Executor adapters MUST implement a single `execute(request)` method receiving an `ExecutionRequest` `{ node, context, signal, nodeKey, resume? }`.
- The interpreter MUST route Agent Steps by the resolved agent definition's `type`: `mock` to the in-memory MockAgentExecutor, and `builtin`/`command` to the acpx-backed AgentExecutor.
- ProgramExecutor MUST handle cmd template resolution, capture config (json/text), `capture.from: file` reads, timeout (SIGKILL), and abort signals.
- ProgramExecutor MUST return raw stdout/stderr and classify failures via `failureKind` (parse, schema, spawn, timeout, killed, capture, exit).
- The runtime MUST treat a non-zero program exit code as step data and fail the Node only when a `failureKind` marks the failure non-recoverable.
- The interpreter MUST write program stdout/stderr as `stdout.log`/`stderr.log` artifacts and record their references on the Node.
- AgentExecutor MUST derive a stable acpx session name from the resolved node key (`acpus-<runId>-<sanitized nodeKey>`), ensuring uniqueness across loop rounds, fanout lanes, and subworkflow nesting.
- AgentExecutor MUST select the underlying agent from the agent definition: a `builtin` `use` value selects an acpx built-in adapter (`acpx <use>`); a `command` `use` value launches a custom ACP server through the acpx `--agent "<use>"` escape hatch.
- AgentExecutor MUST create the saved session via `acpx … sessions ensure --name <session>` before prompting, and run the turn via `acpx … --format json prompt -s <session> <prompt>`.
- AgentExecutor MUST, on first execution, render the Agent Step prompt template; on resume it MUST send a fixed runtime continuation prompt instead and rely on acpx to load/resume the same session.
- AgentExecutor MUST treat the acpx `--format json` ACP NDJSON stream as the transcript: the agent reply is the concatenation of `agent_message_chunk` text, and the final `result.stopReason` classifies the turn.
- AgentExecutor MUST validate the parsed reply against the Step's output schema with Ajv when declared, classifying a non-JSON reply as `parse` and a schema mismatch as `schema`; without a schema it MUST wrap the reply as `{ text }`.
- AgentExecutor MUST return the full ACP NDJSON stream as `stdout` and MUST NOT write artifacts itself; the interpreter owns artifact writes.
- The interpreter MUST always write the agent transcript as a `transcript.jsonl` artifact (and `stderr.log`) and record their references on the Node, on both success and pause.
- On operator pause of a running Agent Step, AgentExecutor MUST request a cooperative ACP cancel via `acpx … cancel -s <session>`, wait for the in-flight turn to settle, and SIGKILL only as a last resort; the interpreter MUST mark the Node `paused` and persist the partial transcript artifact.
- The interpreter MUST resume a paused Agent Step against the same acpx-managed session using the fixed continuation prompt, and MUST recover a dead agent subprocess by re-running the Activity (acpx reloads or resumes the saved ACP session).
- The interpreter MUST automatically retry an Agent Step on parse/schema `failureKind` while the node's `retry.max` budget remains, sleeping `retry.backoff` between attempts.

### Artifacts

- The runtime MUST store node artifacts on the local filesystem under `.acpus/runs/<runId>/artifacts/`.
- Artifact references MUST use the URI format `artifact://runs/<runId>/nodes/<nodeKey>/<filename>`.
- The runtime MUST reject artifact filenames containing `/`, `\`, or `..` to prevent directory traversal.

### Subworkflows

- The runtime MUST resolve a `subworkflow` path relative to the parent spec's source path, compile it with `compileWorkflow`, and execute its root as a nested run.
- Subworkflow file reads and compilation MUST occur in the runtime layer, never in `@acpus/core`.
- The runtime MUST guard against subworkflow cycles by tracking specs currently on the execution stack.
- Subworkflow child Node keys MUST be prefixed with the parent subworkflow Node key to stay unique within the run.

### Daemon

- The runtime MUST expose a daemon process as a long-running Hono HTTP server.
- The daemon MUST listen on `127.0.0.1:3839` by default.
- The daemon MUST expose a REST API for run submission, run listing, run inspection, node state listing, node retrieval, node control (pause, resume, cancel, retry), and run replay.
- When a `resume`, `retry`, or `replay` request targets a Run that is not in the daemon's in-memory interpreter map (e.g. after a daemon restart), the daemon MUST lazily obtain an interpreter for that Run from persisted state, returning a not-found error only when the Run does not exist on disk; `resume`/`retry` reset stale `running` nodes, while `replay` MUST remain read-only.
- `pause` and `cancel` abort an in-flight turn and therefore MUST require a live interpreter; the daemon MUST NOT lazily recover one for them. When no live interpreter exists, the daemon MUST return a conflict error if the Run exists on disk and a not-found error otherwise.
- Run submission MUST execute the run in the background and return the initial `running` state immediately, rather than blocking until the run reaches a terminal state.
- Node keys MUST be passed as `?key=` query parameters in the REST API because node keys contain `/` which is incompatible with path segments.
- The daemon MUST write a PID file at startup.
- The daemon MUST perform startup recovery: reset orphaned `running` nodes to `pending`.
- The daemon MUST perform graceful shutdown on SIGINT/SIGTERM: persist all `running` nodes as `paused`, remove the PID file, close the HTTP server, then exit.
- The daemon MUST use a 5-second forced-exit fallback if the HTTP server does not close promptly.

### Crash Recovery

- The runtime MUST support checkpoint recovery: after an unclean shutdown, a resumed run MUST rebuild state from persisted node files and re-execute only nodes that were `pending` or `running`.
- The runtime MUST support node-level pause, resume, cancel, and retry control operations during execution.
- On resume and retry, the runtime MUST restore the targeted Node's persisted dynamic value-context (fanout item, loop round) into the rebuilt expression context so command and prompt templates re-render identically.
- Operator pause and cancel both abort the in-flight Activity, but the runtime MUST resolve the node to `paused` for pause and `cancelled` for cancel; the operator intent MUST take precedence when an aborted Activity reports a partial result.
- A cancelled Agent Step MUST still persist its partial transcript artifact, the same as a paused one.
- The daemon MUST register a run's interpreter before execution begins so that node-control operations can reach an in-flight run.
- When a child node is paused or cancelled, the runtime MUST propagate the state change to the parent node.

### Replay

- The runtime MUST support deterministic replay of a persisted Run that re-walks the frozen IR snapshot and verifies that the reconstructed Node topology matches the persisted Run.
- Replay MUST NOT execute Agent Steps or Program Steps, MUST NOT write to disk, and MUST NOT re-read mutable YAML.
- Replay MUST be self-deterministic: it MUST reuse the recorded run ID and a frozen clock (the Run's `createdAt`) so the re-walk does not depend on wall-clock time, and MUST NOT depend on random values or large artifact payloads.
- Replay MUST feed recorded per-Node outputs back into the expression context so control-flow decisions (switch branches, loop rounds, fanout lanes) are re-derived deterministically.
- Replay MUST report a structured result indicating success or a list of discrepancies between the recorded and replayed Node topology (the set of reached Node keys); per-Node terminal-state and output equivalence verification is out of scope for this milestone.

## Verification

- Runtime tests MUST cover that Agent Steps are invoked through acpx rather than direct ACP session management by Acpus.
- Runtime tests MUST cover a real Acpus→acpx→Mock Agent end-to-end path for: mid-turn cooperative cancel producing a partial transcript artifact and a `paused` Node; resume re-entering the paused node with the fixed continuation prompt and completing the turn; and recovery of a dead agent subprocess by re-running the Activity.
- Runtime tests MUST cover that Program Steps execute as local subprocesses.
- Runtime tests MUST cover that workflow retry, timeout, pause, resume, and cancel decisions remain owned by Acpus.
- Runtime tests MUST cover that resume and retry restore a Node's persisted dynamic value-context so fanout item and loop round templates re-render correctly.
- Runtime tests MUST cover that, after a daemon restart, `resume`/`retry` on an existing Run recover an interpreter from disk instead of failing, `pause`/`cancel` return a conflict for an existing Run with no live interpreter, and an unknown Run returns not-found.
- Runtime tests MUST cover that replay reproduces a Run's Node topology deterministically, reports discrepancies when the persisted Run's topology is tampered with, and does not mutate persisted state.
- Runtime tests MUST cover that acpx session names are explicit and stable enough for Node-level continuation.
- Runtime tests MUST cover that normal runtime execution does not require remote workers, remote task queues, or a shared Temporal cluster.
- Runtime tests MUST cover the 6-state node lifecycle and all legal transitions.
- Runtime tests MUST cover per-node JSON persistence and atomic write crash safety.
- Runtime tests MUST cover node key resolution with dynamic dimensions (loop, fanout, parallel).
- Runtime tests MUST cover CEL expression evaluation with custom functions and loop rewriting.
- Runtime tests MUST cover fanout lane steps isolation (no shared reference data races).
- Runtime tests MUST cover artifact filename validation (directory traversal prevention).
- Runtime tests MUST cover daemon REST API routes including query-parameter node key handling.
- Runtime tests MUST cover startup recovery (running → pending reset) and graceful shutdown (running → paused persist).
- Runtime tests MUST cover checkpoint recovery after unclean shutdown.
