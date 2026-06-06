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

- Every Node in a Run MUST follow a unified 6-state lifecycle: `pending → running → {completed, failed, paused, cancelled}`.
- A `paused` Node MUST be resumable (transition back to `running`).
- A `failed` Node MUST be retryable (reset to `pending`, then `running`).
- Terminal states (`completed`, `cancelled`) MUST block all further transitions.
- The runtime MUST persist every state transition to disk immediately.

### State Persistence

- The runtime MUST persist per-node state as individual JSON files with atomic write (temp file + rename) for crash safety.
- The runtime MUST persist run-level metadata (run ID, workflow name, status, IR digest, input digest) separately from node state.
- The runtime MUST persist a frozen IR snapshot at run creation and MUST NOT re-read mutable YAML during replay or resume.
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
- ProgramExecutor MUST handle cmd template resolution, capture config (json/text), `capture.from: file` reads, timeout (SIGKILL), and abort signals.
- ProgramExecutor MUST return raw stdout/stderr and classify failures via `failureKind` (parse, schema, spawn, timeout, killed, capture, exit).
- The runtime MUST treat a non-zero program exit code as step data and fail the Node only when a `failureKind` marks the failure non-recoverable.
- The interpreter MUST write program stdout/stderr as `stdout.log`/`stderr.log` artifacts and record their references on the Node.
- AgentExecutor MUST derive stable session names from node keys, send prompts via stdin JSON, parse stdout JSON, and validate output against schemas with Ajv.
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
- The daemon MUST expose a REST API for run submission, run listing, run inspection, node state listing, node retrieval, and node control (pause, resume, cancel, retry).
- Node keys MUST be passed as `?key=` query parameters in the REST API because node keys contain `/` which is incompatible with path segments.
- The daemon MUST write a PID file at startup.
- The daemon MUST perform startup recovery: reset orphaned `running` nodes to `pending`.
- The daemon MUST perform graceful shutdown on SIGINT/SIGTERM: persist all `running` nodes as `paused`, remove the PID file, close the HTTP server, then exit.
- The daemon MUST use a 5-second forced-exit fallback if the HTTP server does not close promptly.

### Crash Recovery

- The runtime MUST support checkpoint recovery: after an unclean shutdown, a resumed run MUST rebuild state from persisted node files and re-execute only nodes that were `pending` or `running`.
- The runtime MUST support node-level pause, resume, cancel, and retry control operations during execution.
- When a child node is paused or cancelled, the runtime MUST propagate the state change to the parent node.

## Verification

- Runtime tests MUST cover that Agent Steps are invoked through acpx rather than direct ACP session management by Acpus.
- Runtime tests MUST cover that Program Steps execute as local subprocesses.
- Runtime tests MUST cover that workflow retry, timeout, pause, resume, and cancel decisions remain owned by Acpus.
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
