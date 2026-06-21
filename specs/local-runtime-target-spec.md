# Local Runtime Target Spec

## Purpose

Acpus runtime execution is a local CLI orchestration boundary for durable single-host workflows that run local ACP agents and local programs. The runtime executes the frozen IR produced by the compiler, persists per-node state for crash recovery, and exposes a Workspace-scoped Run Supervisor API for Run submission, observation, replay, and control.

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
- Agent Steps and Program Steps MUST inherit the executor process environment and MAY add or override variables through their declared `env`.
- The runtime MUST NOT make shell aliases or shell functions available as direct Program Step executables.

### Workspace

- The runtime MUST treat the process current working directory as the Workspace for Run-facing commands.
- The runtime MUST store Workspace runtime state under `.acpus/state/` in the Workspace.
- The runtime MUST store Runs under `.acpus/state/runs/<runId>/`.
- The runtime MUST keep the Workspace as the process current working directory even when runtime state is nested under `.acpus/state/`.
- The runtime MUST NOT infer the Workspace from the Workflow Spec path, repository root, package root, or VCS root.
- The runtime MUST NOT support a `--workspace` override in the first version of Workspace-scoped execution.

### Node State Machine

- Every Node in a Run MUST follow a unified 7-state business lifecycle: `pending → running → {awaiting, completed, failed, paused, cancelled}`.
- A `paused` Node MUST NOT transition directly to `running` through the business lifecycle. Run-level resume MUST recover paused materialized Nodes through a control-plane reset to `pending`.
- An `awaiting` Node (a Signal Node blocked on an external decision) MUST transition only to `completed` (decision delivered) or `cancelled` (operator cancel). `awaiting` MUST be distinct from `paused`.
- `completed`, `failed`, and `cancelled` MUST be terminal in the business lifecycle: they MUST NOT have any outgoing lifecycle transition, and `canTransition`/`transition` MUST reject moving out of them.
- Recovery from a terminal, paused, or stale state MUST be modeled as an explicit control-plane reset, not as a business-lifecycle transition: operator retry MAY reset a `failed` Node to `pending`, Run-level retry of a failed Run MAY reset a materialized `cancelled` Node to `pending`, Run-level resume MAY reset a `paused` Node to `pending`, and crash recovery MAY reset a stale `running` or `awaiting` Node to `pending`. These resets MUST be exposed only through dedicated operations, never through the generic transition API.
- `completed` MUST NOT be resettable by any control-plane operation. A `cancelled` Node MUST remain terminal in the business lifecycle and MUST be resettable only by Run-level retry of a failed Run.
- The runtime MUST persist every state change to disk immediately.

### State Persistence

- The runtime MUST persist per-node state as individual JSON files with atomic write (temp file + rename) for crash safety.
- The runtime MUST persist run-level metadata (run ID, workflow name, optional workflow ref, workflow source path, status, IR digest, input digest, retry generation, evaluated output, error, effective Agent Overrides, and submission warnings) separately from node state.
- Run metadata MUST include `runAttempt`, starting at `1` for a new Run and incrementing by `1` only when a Run-level retry is accepted.
- Run metadata MUST include `output` when the Run completes successfully; this field MUST contain the evaluated top-level Workflow `outputs`.
- Run metadata MUST include `error` when the Run fails with a Run-level error; this field MUST be a string.
- A Node persisted as `completed` MUST NOT retain an `error` value from an earlier failed, paused, or cancelled attempt.
- When a caller does not provide a Run ID, the runtime MUST generate a local-time-sortable Run ID using `yyyyMMddHHmmss` followed by 20 uppercase hexadecimal random characters.
- The runtime MUST persist a frozen IR snapshot at run creation and MUST NOT re-read mutable YAML during replay or resume.
- The runtime MUST apply submit-time Agent Overrides before compiling the frozen IR snapshot for a Run.
- Run metadata `agentOverrides` MUST persist the final effective single-layer Agent Override map applied before IR creation when that map is non-empty. Run metadata `submissionWarnings` MUST persist submit-time warning objects with `code`, `agent`, and `message` when warnings exist.
- Execution, resume, retry, and replay MUST depend on `ir.json` and MUST NOT read Agent Override files or use Agent Override metadata to alter execution after Run creation.
- The runtime MUST persist, for each executable leaf Node, a snapshot of its parent dynamic value-context (fanout item, loop round) so retry can rebuild the expression context without re-deriving ancestor scopes; the snapshot MUST contain only value context, never large artifact payloads.
- The runtime MUST write node keys as filesystem-safe filenames by replacing `/` with `:`.

### Node Keys

- The runtime MUST resolve each Node's `NodeKeyTemplate` plus runtime dynamic context (loop round, fanout item ID, lane ID, parallel branch ID) into a stable key string.
- Node keys MUST always include dynamic dimensions from ancestor scopes, even when the node itself does not use that dimension, to ensure unique keys for nested nodes.
- Node keys MUST use the encoding `workflow/mapped/item:file-a/lane:0` where dynamic dimensions appear as `type:value` suffix segments.
- Nested parallel branch keys MUST use dot-separated branch-id ancestry encoding (e.g., `branch:left.test` for branch `test` inside branch `left`). This ensures inner branches under different outer branches produce distinct node keys, preventing state collisions.
- The `isParallelBranchInScope` helper MUST match a dotted branch key against a scope branch using prefix matching: scope `"left"` matches `"left"`, `"left.test"`, `"left.review"`, etc.; scope `"left.test"` matches only `"left.test"` and `"left.test.x"`.
- `parseNodeKey` MUST return `staticPath`, `staticSegments`, `dynamic` (collapsed, last-value-wins), and `dynamicFrames` (full frame-based parsing where each frame captures one dynamic scope boundary).
- `isNodeKeyBelowAnyAnchor` MUST test whether a node key is a strict descendant (below, not equal to) any of the provided anchor keys. It MUST be used by Run Control cancellation to prevent cross-subworkflow boundary violations.
- Fail-fast Run Control cancellation MUST use the cancelled Composite Node's resolved Node Key as the cancellation root. It MUST cancel active descendants of that Composite Node instance, and MUST NOT cancel nodes in a different subworkflow or dynamic instance merely because they share a Node ID or matching inner dynamic dimensions.
- `ArtifactReferences` MUST provide `make`, `parse`, `tryParse`, `rewriteRunId`, and `resolvePath` methods. Artifact URI node-key segments MUST use percent-encoded resolved Node Keys, while artifact storage directories MUST use filesystem-safe Node Keys. `parse` MUST return `ParsedArtifactReference` with `encodedNodeKey` (URI-encoded form) and `nodeKey` (decoded resolved form for state lookups) such that `parse(make(...).uri).nodeKey` round-trips correctly.
- `planForkedRun` MUST own source Run eligibility, Run Checkpoint reading, Node Definition Hash comparison, and Fork Origin derivation for Forked Runs.
- `materializeForkedRun` MUST own input inheritance, explicit input validation, inherited Node state and Artifact materialization, Run Checkpoint registration, and lineage persistence for Forked Runs.
- `materializeForkedRun` MUST wrap inheritance in try/catch; on failure, it MUST write a `cancelled` run meta with lineage before re-throwing. The returned `MaterializedFork.run` MUST include lineage (re-read after writing).

### Expression Evaluation

- The runtime MUST evaluate `${{ ... }}` expression templates at runtime using a CEL evaluator.
- The runtime MUST rewrite `loop.` references to `loop_ctx.` before evaluation.
- The runtime MUST bind Acpus-owned integer context values (`loop.iter`, `item_index`, and Program Step `exit_code` fields on step envelopes) as CEL integers.
- The runtime MUST share the compiler's Acpus CEL environment registration, including custom functions `now()`, `len()`, `startsWith()`, `matches()`, `coalesce()`, and `json()`.
- `now()` MUST return a deterministic timestamp, not wall-clock time.

### Concurrency

- The runtime MUST use cooperative single-event-loop concurrency (Promise.all/Promise.race).
- The runtime MUST use `p-limit` to cap concurrency for fanout and parallel nodes.
- The runtime MUST allow multiple Runs in the same Workspace to execute concurrently through the Run Supervisor.
- The runtime MUST NOT enforce a Run Supervisor-level global Run queue or maximum concurrent Run limit in the first version.
- Fanout lanes MUST receive fresh shallow copies of the steps context to prevent data races.
- A `race` wait strategy MUST NOT cancel losing branches/lanes; their settled results MUST be consumed to avoid unhandled rejections.

### Executors

- The runtime MUST support mock executor adapters for testing (MockProgramExecutor).
- The runtime MUST provide a StubAgentExecutor in test helpers for fast unit tests (no acpx, no mock scripts, no Ajv validation).
- The runtime MUST support a real ProgramExecutor using `execa` for local subprocess execution.
- The runtime MUST support a real AgentExecutor spawning `acpx` via `execa` for ACP session management.
- Executor adapters MUST implement a single `execute(request)` method. `ExecutorAdapter` MAY be specialized with a request subtype.
- Every executor request MUST include `node`, `context`, `signal`, `nodeKey`, and a discriminator `kind`.
- Agent executor requests MUST use `kind: "agent"` and MAY include prepared Agent execution fields: `prompt`, `sessionKey`, `continuation`, `retry`, and `onStream`.
- Program executor requests MUST use `kind: "program"` and MAY include `injectedEnv` from `beforeProgramExec`.
- Agent-only request fields MUST NOT be required by Program executors, and Program-only request fields MUST NOT be required by Agent executors.
- When an Agent Step declares `session_key`, the interpreter MUST pass the rendered semantic key to the Agent executor as `AgentExecutionRequest.sessionKey`.
- The interpreter MUST persist the rendered Agent prompt prepared for the current Agent executor call on the Agent Node state as `renderedPrompt`.
- The interpreter MUST persist the rendered Signal Node prompt (with expressions resolved) on the Signal Node state as `renderedPrompt` before entering `awaiting`, so operators can see what decision is requested without inspecting the frozen IR.
- When an Agent Step declares `session_key`, the interpreter MUST persist the rendered semantic key on the Agent Node state as `renderedSessionKey`; Agent Steps without explicit `session_key` MUST omit `renderedSessionKey`.
- The interpreter MUST route all Agent Steps through the single AgentExecutor (acpx-backed); there is no `type: mock` dispatch.
- ProgramExecutor MUST handle cmd template resolution, capture config (json/text), `capture.from: file` reads, timeout (SIGKILL), and abort signals.
- ProgramExecutor MUST execute string `cmd` values with shell semantics.
- ProgramExecutor MUST execute array `cmd` values without shell expansion, using the first array element as the executable and remaining elements as arguments.
- ProgramExecutor MUST return raw stdout/stderr and classify failures via `failureKind` (parse, schema, spawn, timeout, killed, capture, exit).
- ProgramExecutor MUST treat a non-zero program exit code that is not allow-listed by the Program Step's `expect.exit_code` (default `[0]`) as `failureKind: "exit"` and MUST localize the failure in its error string with the exit code and a tail of stderr.
- ProgramExecutor MUST evaluate `expect.exit_code` before capture parsing and output schema validation; an exit-classified failure MUST NOT be reported as a capture or schema failure.
- ProgramExecutor output schema validation failure diagnostics MUST include schema validation details and SHOULD include a bounded captured-output preview.
- The runtime MUST treat an allow-listed program exit code as step data and MUST fail the Node only when a `failureKind` marks the failure non-recoverable.
- The interpreter MUST write program stdout/stderr as `stdout.log`/`stderr.log` artifacts and record their references on the Node.
- AgentExecutor MUST derive a stable acpx session name from the resolved node key (`acpus-<runId>-<sanitized nodeKey>`) when an Agent Step does not declare `session_key`, ensuring uniqueness across loop rounds, fanout lanes, and subworkflow nesting by default.
- AgentExecutor MUST derive a stable acpx session name from the Run id and rendered `session_key` when an Agent Step declares `session_key`, using a collision-resistant safe encoding for the rendered key and allowing explicit same-Run session sharing across materialized Agent Steps.
- AgentExecutor MUST evaluate `session_key` as a template string using the Agent Step execution context before touching acpx, and deterministic `session_key` evaluation failures MUST be classified as configuration failures.
- A rendered `session_key` MUST NOT be empty or blank.
- A recovered Run interpreter MUST bind `now()` to the persisted Run creation clock so `session_key` templates remain stable across supervisor recovery, resume, and retry.
- AgentExecutor MUST NOT automatically namespace `session_key` by agent definition and MUST NOT add Acpus-side serialization for concurrent Agent Steps that render the same `session_key`; ordering and conflict behavior are delegated to acpx.
- AgentExecutor MUST select the underlying agent from the agent definition: a `builtin` `use` value selects an acpx built-in adapter (`acpx <use>`); a `command` `use` value launches a custom ACP server through the acpx `--agent "<use>"` escape hatch.
- AgentExecutor MUST create the saved session via `acpx … sessions ensure --name <session>` before prompting, and run the turn via `acpx … --format json prompt -s <session> <prompt>`.
- When an Agent Step declares `timeout`, AgentExecutor MUST convert that timeout to seconds and pass it to acpx as the global `--timeout <seconds>` option.
- AgentExecutor MUST resolve effective Agent Policy as `step.policy ?? agent.policy ?? "full"` and map it to acpx flags: `full` MUST produce `--approve-all --non-interactive-permissions deny`; `read` MUST produce `--approve-reads --non-interactive-permissions fail`. Policy flags MUST be passed to both `sessions ensure` and `prompt` commands. `--approve-all` and `--approve-reads` MUST be mutually exclusive.
- AgentExecutor MUST, on first execution, render the Agent Step prompt template; on Run-level resume of a paused Agent Step or manual Node-level retry of a failed Agent Step it MUST send only a fixed runtime continuation prompt and rely on acpx to load the same session; on a parse/schema auto-retry it MUST send the fixed continuation prompt.
- When an output schema is declared, AgentExecutor MUST append it to the prompt as an explicit `# OUTPUT SCHEMA` section on the first execution and on parse/schema auto-retries, but MUST NOT append it on Run-level resume of a paused Agent Step or manual Node-level retry of a failed Agent Step.
- The `# OUTPUT SCHEMA` section MUST include the instruction `After completing the task, your final response MUST be exactly one JSON object that conforms to this schema, with no Markdown, prose, or extra keys.` before the schema serialized as pretty JSON.
- AgentExecutor MUST treat the acpx `--format json` ACP NDJSON stream as the Agent activity source: the agent reply is the concatenation of `agent_message_chunk` text, the final `result.stopReason` classifies the turn, final `result.usage` reports opt-in PromptResponse token usage when the ACP agent provides it, and `usage_update.used`/`usage_update.size` report the latest context window occupancy.
- AgentExecutor MUST persist PromptResponse token usage only when final `result.usage` contains at least one non-negative token field, with source `prompt_response`; when absent, token usage MUST remain unavailable and MUST NOT be estimated from visible text or inferred from `usage_update.used`/`usage_update.size`.
- When an output schema is declared, AgentExecutor MUST extract a JSON value from the reply before validation, tolerating prose and Markdown code fences around it: it MUST try the whole reply first, then independently scan `{...}`/`[...]` candidates from each opening brace or bracket so unbalanced prose or code fragments cannot block later candidates. It MUST evaluate candidates by final text position from latest to earliest, trying strict JSON parse and then `jsonrepair` for the same later candidate before considering earlier candidates. It MUST NOT repair non-JSON prose fragments such as index/range expressions or TypeScript object snippets into output. It MUST classify a reply from which no JSON can be extracted as `parse`, and validate the extracted value against the schema with Ajv, classifying a schema mismatch as `schema`. Without a schema it MUST wrap the reply as `{ text }` without attempting extraction.
- AgentExecutor MUST NOT require the full ACP NDJSON stream to be buffered in memory before it can classify the turn or return the reconstructed response text.
- The interpreter MUST write Agent Step artifacts per attempt using the filenames `attempt-NNN.prompt.md`, `attempt-NNN.response.md`, `attempt-NNN.telemetry.json`, and `attempt-NNN.stderr.log` when the corresponding content is available.
- `attempt-NNN.prompt.md` MUST contain the fully rendered prompt/request prepared for that Agent executor call.
- `attempt-NNN.response.md` MUST contain the human-readable agent response text reconstructed from the ACP stream, not a duplicate of structured `node.output`.
- `attempt-NNN.telemetry.json` MUST contain the final compact per-attempt Agent telemetry summary that was published on Node state.
- `NodeExecutionState.agentTelemetry` MUST store compact Agent telemetry as `{ currentAttempt, attempts }`. Each attempt summary MUST include attempt number, attempt state, timestamps, latest context usage when available, PromptResponse token usage when available, bounded input/output previews, and compact tool-call telemetry.
- Agent telemetry input and output previews MUST use an 8 KiB head plus 8 KiB tail budget and MUST point to full prompt/response artifacts through artifact refs when those artifacts exist.
- Agent telemetry tool use MUST count unique non-empty `toolCallId` values from live acpx stdout `tool_call` and `tool_call_update` ACP updates. It MUST retain at most the most recent 200 compact tool call records, MUST preserve `totalToolCallCount`, and MUST expose `droppedToolCallCount` when older tool details are discarded.
- Agent telemetry MUST NOT infer tool calls from `agent_thought_chunk`, `agent_message_chunk`, or other natural-language ACP chunks. Agent-internal read, shell, or search activity that the ACP agent does not expose as `tool_call` / `tool_call_update` events is outside this telemetry source.
- Compact tool call records MUST NOT persist full `rawInput` or `rawOutput`; they MAY include only `toolCallId`, `title`, `kind`, `toolName`, `status`, and timestamps.
- While acpx is running, the interpreter MUST coalesce ordinary telemetry writes to Node state to at most once per second, but MUST publish tool starts, status changes, and final statuses immediately.
- The interpreter MUST NOT write `attempt-NNN.transcript.jsonl` during normal execution. When `ACPUS_AGENT_RAW_ACP_DEBUG=1` is set, the interpreter MAY write `attempt-NNN.acp-debug.jsonl` as a debug artifact, and TUI/CLI behavior MUST NOT depend on that artifact.
- Agent attempt artifact numbering MUST use one monotonically increasing attempt sequence for first execution, automatic retry, manual retry, and Run-level resume.
- The interpreter MUST record all Agent attempt artifact references on the Node so visualizers can show prior failed/retried attempts.
- The interpreter MUST NOT write fixed-name Agent artifacts such as `telemetry.json`, `transcript.jsonl`, or `stderr.log` that would be overwritten by later attempts.
- On Run-level pause of a running Agent Step, AgentExecutor MUST request a cooperative ACP cancel via `acpx … cancel -s <session>`, wait for the in-flight turn to settle, and SIGKILL only as a last resort; the interpreter MUST mark the Node `paused` and persist partial response/telemetry artifacts.
- On Run-level resume, the interpreter MUST continue a paused Agent Step against the same acpx-managed session using the fixed continuation prompt. On manual Node-level retry of a failed Agent Step, the interpreter MUST recover a dead agent subprocess by re-running the Activity (acpx loads the saved ACP session).
- The interpreter MUST automatically retry an Agent Step on Agent response output parse/schema `failureKind` while the node's effective `retry.max` budget remains, sleeping `retry.backoff` between attempts.
- The interpreter MUST use an effective `retry.max` of `2` for Agent Steps with an output schema and no explicit `retry.max`.
- Deterministic Agent configuration or template failures MUST be classified as non-retryable failures and MUST NOT consume automatic output retry attempts.

### Artifacts

- The runtime MUST store node artifacts on the local filesystem under `.acpus/state/runs/<runId>/artifacts/`.
- Artifact references MUST use the URI format `artifact://runs/<runId>/nodes/<nodeKey>/<filename>`.
- The runtime MUST reject artifact filenames containing `/`, `\`, or `..` to prevent directory traversal.

### Subworkflows

- The runtime MUST resolve a `subworkflow` path relative to the parent spec's source path, compile it with `compileWorkflow`, and execute its root as a nested run.
- The runtime MUST validate Workflow Spec source paths and include targets by resolving real filesystem paths after symlink resolution.
- The runtime MUST reject Workflow Spec source paths and include targets that do not exist or cannot be read.
- The runtime MUST NOT restrict Workflow Spec source paths or include targets to the current Workspace or `$HOME/.acpus/workflows/` roots.
- Subworkflow file reads and compilation MUST occur in the runtime layer, never in `@acpus/core`.
- The runtime MUST guard against subworkflow cycles by tracking specs currently on the execution stack.
- Subworkflow child Node keys MUST be prefixed with the parent subworkflow Node key to stay unique within the run.

### Run Supervisor

- The runtime MUST expose a Workspace-scoped Run Supervisor as the local execution authority for Run-facing CLI commands.
- The Run Supervisor MUST be lazily started by Run-facing CLI commands when no healthy supervisor exists for the current Workspace.
- A newly started Run Supervisor MUST inherit the full environment of the CLI process that starts it, excluding only variables whose value is undefined.
- The runtime MUST allow at most one active Run Supervisor per Workspace.
- The Run Supervisor MUST listen on `127.0.0.1` using a random available TCP port.
- The Run Supervisor MUST expose its endpoint through `.acpus/state/supervisor.json` in the Workspace.
- `.acpus/state/supervisor.json` MUST include `schemaVersion`, absolute `workspace`, `pid`, `endpoint`, `startedAt`, and `version` fields.
- The runtime MUST use `.acpus/state/supervisor.lock` or an equivalent Workspace-local lock to prevent concurrent CLI invocations from starting multiple supervisors for the same Workspace.
- When ensuring a supervisor, the CLI MUST verify that `.acpus/state/supervisor.json` matches the current Workspace and that the endpoint health check succeeds.
- When supervisor metadata is stale, unreachable, malformed, or for a different Workspace, the CLI MUST clean or replace it before using a supervisor.
- The Run Supervisor MUST expose an HTTP REST API for run submission, run listing, run inspection, node state listing, node retrieval, Run-level control, Node-level retry, Signal Node decision delivery, run replay, frozen IR retrieval, evaluated workflow output retrieval, artifact path resolution, and health checks.
- Run-facing CLI commands MUST use the Run Supervisor API rather than maintaining a separate direct-disk read path.
- The runtime MUST NOT require a normal user-facing `acpus daemon` or `acpus supervisor` command for normal execution.
- The Run Supervisor MUST execute submitted Runs in the background and return the initial `running` state immediately, rather than blocking until the Run reaches a terminal state.
- The Run Supervisor MUST register a Run's interpreter before execution begins so that control operations can reach an in-flight Run.
- The Run Supervisor MUST report include/source file resolution failures as `INCLUDE_RESOLUTION` diagnostics.
- The Run Supervisor MUST NOT report ordinary schema, YAML, or compiler validation diagnostics as `INCLUDE_RESOLUTION`.
- The Run Supervisor MUST keep running while at least one Run is `running` or at least one follow/visualize client is actively polling.
- The Run Supervisor MUST exit after five idle minutes when there are no `running` Runs and no active follow/visualize clients.
- `paused`, `completed`, `failed`, and `cancelled` Runs MUST NOT by themselves keep an otherwise idle Run Supervisor alive.
- The Run Supervisor MUST perform startup recovery: reset orphaned `running` or `awaiting` Nodes to `pending` as a control-plane recovery operation.
- The Run Supervisor MUST perform graceful shutdown on SIGINT/SIGTERM: persist all live `running` Nodes as `paused`, remove supervisor metadata, close the HTTP server, then exit.
- The Run Supervisor MUST use a 5-second forced-exit fallback if the HTTP server does not close promptly.
- Node keys MUST be passed as `?key=` query parameters in the REST API for Node-level retry, node retrieval, Signal Node decision delivery, and artifact path resolution because node keys contain `/` which is incompatible with path segments.
- `GET /runs/:runId/input` MUST return `{ input }` containing the persisted resolved Workflow input for the Run.
- `GET /runs/:runId/output` MUST return `{ status, output }` and MAY include `error` as a string when the Run has failed.
- `GET /runs/:runId/output` MUST return the persisted evaluated top-level Workflow `outputs` when `status` is `completed`.
- `GET /runs/:runId/output` MUST return `{}` for `output` when the Run is `running`, `failed`, `paused`, or `cancelled`.
- The runtime MUST evaluate top-level Workflow `outputs` exactly once after all Nodes complete successfully, persist the evaluated value on Run metadata, and serve that persisted value through the Run Supervisor.
- If top-level Workflow `outputs` evaluation fails after successful Node execution, the runtime MUST fail the Run, persist the evaluation error on Run metadata, and mark the root Workflow Node as failed while preserving completed child Node state.

### Run Observations

- The runtime MUST support human-facing Run Observations derived from persisted Run and Node state snapshots.
- Run Observations MUST NOT be modeled as a persisted append-only event history in the first version.
- Foreground follow clients MUST poll Run and Node state at a 400ms interval by default.
- A follow client MUST print or emit a Node observation only when the Node is first observed or when its state changes.
- A follow client MUST NOT repeatedly print unchanged Node states.
- A follow client MUST NOT invent unobserved intermediate states when a Node changes faster than the polling interval.
- A follow client MUST follow only the Run submitted by that `acpus workflows run` invocation, not other concurrent Runs in the Workspace.
- Run Observations MUST NOT include raw Program stdout, raw Program stderr, Agent transcript chunks, or log lines.

### Run Listing and Watching

- The Run Supervisor MUST list Runs sorted by `updatedAt` descending.
- Run listing for `acpus runs list` and the visualizer picker MUST return the most recent 50 Runs in the Workspace in the first version.
- `acpus runs visualize` without a Run ID MUST open a picker backed by Run listing; it MUST NOT require a multi-Run dashboard.
- `acpus runs visualize <runId>` and `acpus workflows run --visualize` MUST open the single-Run visualizer view for the selected or submitted Run.
- `acpus runs visualize [runId] --serve [listen]` MUST start a foreground Served Visualizer bridge outside the Run Supervisor.
- The Served Visualizer bridge MUST connect to the existing Workspace Run Supervisor as a visualize client, and MUST NOT become the Run Supervisor, replace the Run Supervisor, or write supervisor discovery metadata.
- Stopping the Served Visualizer bridge MUST close browser access and its terminal child processes, and MUST NOT stop the Run Supervisor or mutate any Run.
- Each browser connection to the Served Visualizer bridge MUST receive an independent read-only visualizer session.
- Terminal visualizer sessions MUST poll live Run and Node state every one second. Served Visualizer sessions MUST poll live Run and Node state every three seconds and MUST use a non-animated live indicator.
- The Served Visualizer bridge MUST require an unguessable bridge token for the browser page and WebSocket endpoint, and MUST reject browser WebSocket upgrades whose `Origin` header does not match the request `Host`.
- The Served Visualizer bridge MUST allow at most eight active browser sessions and MUST reject excess WebSocket connections before spawning a terminal child process.
- The Served Visualizer bridge MUST bound browser-to-bridge messages to 1 MiB and MUST clamp terminal resize requests to at most 500 columns and 200 rows.
- The Served Visualizer bridge MUST serve browser assets only for `GET` requests, MUST return generic `404` responses for missing static assets, and MUST NOT serve source maps.
- The single-Run visualizer view MUST render the frozen IR snapshot and overlay persisted Node states.
- For a selected Agent Step, the single-Run visualizer MUST derive Agent execution telemetry from `NodeExecutionState.agentTelemetry`, not from transcript artifacts.
- Agent execution telemetry MUST show the current attempt's total tool-call count and the three retained Tool calls with the most recent structured update.
- Agent execution telemetry MUST show latest Agent context window occupancy from the current telemetry attempt as `used/size` when available.

### Run-Level Control

- The runtime MUST support Run-level pause, resume, cancel, and retry operations.
- The runtime MUST support Run cleanup for deleting stored terminal Run directories.
- Run-level `pause` MUST be accepted only for a `running` Run.
- Run-level `pause` MUST immediately cooperative-pause the Run by aborting currently running executable Nodes as `paused` and preventing further pending Node scheduling until the Run is resumed.
- Run-level `cancel` MUST be accepted only for `running` or `paused` Runs.
- Run-level `cancel` MUST make the Run terminal `cancelled`.
- Run-level `cancel` MUST abort materialized running Nodes as `cancelled`, mark materialized pending Nodes as `cancelled`, and MUST NOT create state for unmaterialized Nodes.
- Run-level `resume` MUST be accepted only for a `paused` Run.
- Run-level `resume` MUST continue a paused Run from persisted paused and pending state.
- Run-level `resume` MUST reset paused materialized Nodes to `pending` as a control-plane operation and re-execute from the frozen IR without rerunning completed Nodes.
- Run-level `resume` MUST send the fixed continuation prompt when it re-enters a paused Agent Step.
- Run-level `retry` MUST be accepted only for a `failed` Run.
- Run-level `retry` MUST perform in-place recovery of failed, paused, and cancelled materialized Nodes and MUST NOT rerun completed Nodes.
- Run-level `retry` MUST increment the Run's `runAttempt`.
- Run-level `retry` MUST NOT create a new Run and MUST NOT mean rerun from scratch.
- Run-level `retry` MUST reset recovered failed, paused, and cancelled materialized Nodes to `pending`.
- Run-level `retry` MUST clear the Run metadata `output` and `error` fields before re-execution.
- Run-level `retry` MUST clear recovered Nodes' stale attempt fields, including `startedAt`, `completedAt`, `error`, `output`, `artifactRefs`, `dynamicContext`, and `agentTelemetry`.
- Invalid Run-level control operations MUST be rejected with a conflict error and MUST leave persisted state unchanged.
- Run cleanup MUST delete only Run directories whose Run metadata status is `completed`, `failed`, or `cancelled`.
- Run cleanup MUST preserve Run directories whose Run metadata status is `running` or `paused`.
- Run cleanup MUST skip Run directories whose metadata is unreadable or corrupt.
- Run cleanup dry-run MUST report the same deletion candidates without deleting files.
- Run cleanup results MUST include deleted and skipped Run IDs, counts, statuses when known, and estimated bytes reclaimed.

### Forked Runs

- The runtime MUST persist Run Checkpoints under `.acpus/state/runs/<runId>/checkpoints.index.json` as an ordered array; each entry MUST include `sequence`, `nodeKey`, terminal `state`, `definitionHash`, and `completedAt`.
- The runtime MUST append a Run Checkpoint whenever a Node enters a terminal state (`completed`, `failed`, `cancelled`); a re-attempt of the same Node MUST update its checkpoint entry in place, preserving the original `sequence`.
- Each persisted Node state MUST carry the Node Definition Hash that produced it; the runtime MUST treat the hash as opaque outside of fork planning.
- A Node Definition Hash MUST include the Workflow metadata context (`workflow.name`, `workflow.description`, `workflow.source_path`, `workflow.source_dir`) when that Node or its descendant subtree references `workflow.*`; changing the Workflow source path or other referenced Workflow metadata MUST prevent inheritance of affected Nodes in Forked Runs.
- The runtime MUST expose a `POST /runs/:runId/fork` Run Supervisor route accepting a Workflow Spec, optional `sourcePath`, `workflowRef`, `input`, `overrideOriginNodeKey`, `dryRun`, and `agentOverrides`.
- Fork submission MUST be rejected with a conflict error when the source Run is in a non-terminal state (`running`, `paused`, or `awaiting`) or when the source Run has no checkpoint index.
- Fork planning MUST scan the source Run's checkpoints in `sequence` order and inherit each Node whose Node Key has a matching static counterpart in the new Spec, whose prior state is `completed`, and whose Node Definition Hash matches the new compiled IR; inheritance MUST stop at the first Node failing any of these checks (the inheritance boundary).
- The default Fork Origin MUST be the inheritance boundary determined by the scan; an operator override MAY force an earlier Origin but MUST NOT be a Node inside a Composite (`parallel`, `fanout`, `loop`, `switch`, `subworkflow`) body.
- A Forked Run MUST be its own Run with its own frozen IR snapshot and MUST NOT mutate the source Run.
- A Forked Run MUST inherit the source Run's persisted effective Agent Override map by default. Missing `agentOverrides` on an older source Run MUST be treated as an empty map.
- Fork Agent Override resolution MUST filter inherited override entries to agents still declared by the repaired top-level Workflow Spec, MUST emit `INHERITED_AGENT_OVERRIDE_SKIPPED` for skipped inherited entries, and MUST NOT reject the fork solely because an inherited override no longer has a matching agent.
- Current fork `agentOverrides` MUST merge on top of inherited Agent Overrides and MUST reject unknown current override agents.
- A Forked Run MUST persist the final effective single-layer Agent Override map when that map is non-empty and MUST NOT persist separate inherited/current override layers or the `--agents` source path.
- Inherited Nodes MUST be materialized in the Forked Run by copying their persisted Node state and artifact directory from the source Run, rewriting artifact URIs to the new Run ID; subsequent execution MUST short-circuit on these completed Nodes.
- A Forked Run's `run-meta.json` MUST persist `lineage` containing `sourceRunId`, `forkOriginNodeKey`, and `inheritedNodeCount`; the lineage MUST refer only to the immediate prior Run and MUST NOT carry deeper ancestry.
- `dryRun: true` MUST return the Fork Plan (`sourceRunId`, `inheritedNodeKeys`, `defaultForkOriginNodeKey`, `forkOriginNodeKey`, `boundaryReason`) without creating a Run.
- Fork dry-run planning MUST use the effective overridden IR and MUST return `agentOverrides` and `submissionWarnings`.
- A Forked Run MUST treat inherited outputs as historical facts and MUST NOT recompute runtime-context values (such as `run_id` or `now()` derivations) embedded in those outputs.
- A Forked Run MUST start fresh ACP sessions for any Agent Step it executes; Continuation MUST NOT span Runs.

### Node-Level Retry And Signal Delivery

- The runtime MUST support Node-level retry only for failed executable Nodes (`run.agent` and `run.program`).
- Node-level retry MUST be addressed through an explicit node key parameter in the API and through `acpus runs retry <run_id> --node <nodeKey>` in the CLI.
- Node-level retry MUST be accepted only when the target Node is `failed`, the target Node is executable, and the Run is `failed`.
- Node-level retry MUST restore the targeted executable Node's persisted dynamic value-context (fanout item, loop round) into the rebuilt expression context so command and prompt templates re-render identically.
- Node-level retry MUST resolve the targeted Node's definition from the Run's persisted IR before mutating Node state, and MUST reject the operation with an error (leaving Node state unchanged) when the definition cannot be resolved. Subworkflow child Nodes, whose IR is compiled on demand and not persisted in the parent Run, are therefore not individually retryable.
- Node-level retry HTTP requests MUST return after validation and execution startup; they MUST NOT hold the client request open until the retried Node finishes executing.
- Node-level retry MUST NOT mutate composite ancestor Nodes and MUST NOT change Run status; Run-level retry is the operation that restores Workflow progress after a failed Run.
- The runtime MUST support delivering an external decision payload to a Signal Node that is `awaiting`, addressed through an explicit node key parameter (`--node <nodeKey>` in the CLI). When the Signal Node declares an `output` schema, the payload MUST validate against it and a non-conforming payload MUST be rejected without resolving the Node; when no schema is declared any payload object is accepted.
- Signal decision delivery MUST require a live interpreter (the decision channel is in-memory); the Run Supervisor MUST NOT lazily recover one. When no live interpreter exists, it MUST return a conflict error if the Run exists on disk and a not-found error otherwise, and MUST return a conflict error when the targeted Node is not `awaiting`.
- A cancelled Agent Step MUST still persist its partial response and telemetry artifacts, the same as a paused one.

### Crash Recovery

- The runtime MUST support checkpoint recovery: after an unclean shutdown, a resumed or retried Run MUST rebuild state from persisted node files and re-execute only nodes that were reset to `pending` or were already `pending`.
- The runtime MUST preserve completed Node outputs during recovery, resume, and retry.
- The runtime MUST NOT re-read mutable YAML during recovery, resume, retry, or replay.

### Replay

- The runtime MUST support deterministic replay of a persisted Run that re-walks the frozen IR snapshot and verifies that the reconstructed Node topology matches the persisted Run.
- Replay MUST NOT execute Agent Steps or Program Steps, MUST NOT write to disk, and MUST NOT re-read mutable YAML.
- Replay MUST be self-deterministic: it MUST reuse the recorded run ID and a frozen clock (the Run's `createdAt`) so the re-walk does not depend on wall-clock time, and MUST NOT depend on random values or large artifact payloads.
- Replay MUST feed recorded per-Node outputs back into the expression context so control-flow decisions (switch branches, loop rounds, fanout lanes) are re-derived deterministically.
- Replay MUST report a structured result indicating success or a list of discrepancies between the recorded and replayed Node topology (the set of reached Node keys); per-Node terminal-state and output equivalence verification is out of scope for this milestone.
- Replay MUST remain read-only even when invoked through a lazily started Run Supervisor.

### Guard Nodes

- The runtime MUST execute Guard Nodes as deterministic condition checks against the current expression context.
- A Guard Node action of `continue` MUST complete the Guard Node and allow the current scope to continue.
- A Guard Node action of `fail` MUST fail the Guard Node, persist its output envelope, and propagate failure through existing parent composite failure semantics.
- A Guard Node action of `complete` MUST complete the Guard Node and stop executing later sibling Nodes in the current scope.
- A Guard Node `complete` action MUST NOT directly terminate outer scopes except when the current scope is the Workflow root.
- A completed or failed Guard Node MUST persist an output envelope whose `output` field contains `matched` and `action`, and MUST include `message` only when the selected action is `fail` and a Guard message template is declared.

## Verification

- Runtime tests MUST cover that Agent Steps are invoked through acpx rather than direct ACP session management by Acpus.
- Runtime tests MUST cover default Run ID generation using a local-time sortable timestamp prefix and uppercase random suffix.
- Runtime tests MUST cover that Agent Step attempts publish prompt artifacts and compact live telemetry while the Node is running, write per-attempt prompt/response/telemetry artifacts, persist latest Agent context window occupancy and opt-in PromptResponse token usage when available, leave token usage unavailable when absent, and preserve earlier attempt artifact references across automatic retry.
- Runtime tests MUST cover a real Acpus→acpx→Mock Agent end-to-end path for: Run-level pause producing partial telemetry and a `paused` Agent Step; Run-level resume re-entering the paused Agent Step with the fixed continuation prompt and completing the turn; and Node-level retry recovering a dead agent subprocess by re-running the Activity.
- Runtime tests MUST cover that Program Steps execute as local subprocesses.
- Runtime tests MUST cover Program Step default fail-fast on a non-allow-listed exit code with a stderr-tail in the failure message, and `expect.exit_code` allow-list opt-out.
- Runtime tests MUST cover that exit-classified failure precedes capture and schema validation.
- Runtime tests MUST cover that workflow retry, timeout, pause, resume, and cancel decisions remain owned by Acpus.
- Runtime tests MUST cover Workspace-scoped lazy Run Supervisor startup, stale metadata replacement, health checks, and lock-protected concurrent startup.
- Runtime tests MUST cover that the Run Supervisor uses a random localhost port and writes `.acpus/state/supervisor.json` with the required fields.
- Runtime tests MUST cover that normal Run-facing CLI commands use the Run Supervisor API and do not require a manual daemon command.
- Runtime tests MUST cover that one Workspace has at most one active Run Supervisor and that different current working directories use different Workspace state.
- Runtime tests MUST cover that the Run Supervisor exits after five idle minutes with no running Runs or active follow/visualize clients.
- Runtime tests MUST cover multiple concurrent Runs in the same Workspace.
- Runtime tests MUST cover Run-level pause, resume, cancel, and retry state validation and effects.
- Runtime tests MUST cover Run cleanup deleting terminal Runs, preserving running and paused Runs, skipping corrupt metadata, and dry-run behavior.
- Runtime tests MUST cover that Run-level retry is in-place recovery and does not rerun completed Nodes or create a new Run.
- Runtime tests MUST cover that new Runs start with `runAttempt: 1` and Run-level retry persists an incremented `runAttempt`.
- Runtime tests MUST cover that completed Runs persist evaluated top-level Workflow output, that output evaluation failures persist a Run-level error, and that Run-level retry clears Run metadata `output` and `error` before re-execution.
- Runtime tests MUST cover that Run-level resume resets paused materialized Nodes to `pending` and re-executes without rerunning completed Nodes.
- Runtime tests MUST cover that Node-level retry restores a failed executable Node's persisted dynamic value-context so fanout item and loop round templates re-render correctly.
- Runtime tests MUST cover that Node-level retry returns promptly while retried execution continues in the background.
- Runtime tests MUST cover that, after a Run Supervisor restart, Node-level `retry` on an existing failed Run recovers an interpreter from disk instead of failing, and an unknown Run returns not-found.
- Runtime tests MUST cover that startup recovery resets orphaned `running` Nodes to `pending`.
- Runtime tests MUST cover graceful shutdown persisting live `running` Nodes as `paused` and removing supervisor metadata.
- Runtime tests MUST cover checkpoint recovery after unclean shutdown.
- Runtime tests MUST cover Run Observations generated by polling and diffing Run/Node state, including de-duplication of unchanged Nodes and no invented intermediate states.
- Runtime tests MUST cover that follow clients do not stream raw Program stdout, Program stderr, or Agent transcript chunks as Run Observations.
- Runtime tests MUST cover Run listing and the visualize picker returning the most recent 50 Runs sorted by `updatedAt` descending.
- Runtime tests MUST cover that replay reproduces a Run's Node topology deterministically, reports discrepancies when the persisted Run's topology is tampered with, and does not mutate persisted state.
- Runtime tests MUST cover Guard Node continue, fail, and complete actions, including scoped early completion inside fanout lanes or parallel branches.
- Runtime tests MUST cover that acpx session names are explicit and stable enough for Run-level continuation and Node-level retry.
- Runtime tests MUST cover Agent Step `session_key` session-name selection, template evaluation, default node-key-derived behavior, and same-Run shared-session behavior across loop materializations.
- Runtime tests MUST cover that normal runtime execution does not require remote workers, remote task queues, or a shared Temporal cluster.
- Runtime tests MUST cover the 7-state node lifecycle and all legal transitions.
- Runtime tests MUST cover per-node JSON persistence and atomic write crash safety.
- Runtime tests MUST cover node key resolution with dynamic dimensions (loop, fanout, parallel).
- Runtime tests MUST cover CEL expression evaluation with custom functions and loop rewriting.
- Runtime tests MUST cover fanout lane steps isolation (no shared reference data races).
- Runtime tests MUST cover artifact filename validation (directory traversal prevention).
- Runtime tests MUST cover Run Supervisor REST API routes including query-parameter node key handling.
- Runtime tests MUST cover Run Checkpoint persistence on terminal Node transitions, including in-place update on a re-attempt.
- Runtime tests MUST cover Agent Override metadata persistence on Run creation and exposure through Run inspection.
- Runtime tests MUST cover effective compiled IR containing overridden Agent Step `metadata.agent`, equivalent effective IR producing matching Node Definition Hashes, and agent identity changes affecting referenced Agent Step hashes.
- Runtime tests MUST cover that retry, resume, and replay read only the frozen IR and do not read Agent Override files or metadata after Run creation.
- Runtime tests MUST cover Forked Run inheritance: completed/failed/cancelled source Run, first-divergence default origin, hash-mismatch and missing-Node truncation, operator override (including rejection inside a Composite body), input inheritance, and persisted lineage.
- Runtime tests MUST cover Forked Run inheritance invalidation for Nodes that reference `workflow.*` when the Workflow metadata context changes, while preserving inheritance for workflow-independent Nodes.
- Runtime tests MUST cover Forked Runs inheriting source effective Agent Overrides by default, current fork overrides winning, fork-of-fork preserving the persisted single-layer map, and inherited overrides for removed agents being skipped with warnings.
- Runtime tests MUST cover that a Forked Run runs to completion using inherited Nodes without re-executing them.
- Runtime tests MUST cover `dryRun` fork planning returning the plan without creating a Run, and the supervisor rejecting fork on non-terminal source Runs.
