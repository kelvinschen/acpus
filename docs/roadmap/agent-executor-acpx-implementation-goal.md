# Acpx-backed Agent Executor Implementation Goal

This document turns the agent-executor design decisions into an executable
implementation goal. It is a roadmap execution aid, not current product truth.
Current implemented behavior lives in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Background

`acpus_next` is a TypeScript-first rebuild of the legacy workflow/runtime
stack. The current next runtime already has a durable scheduler and a small
`@acpus/agent-executor` package, but the agent path is still a raw
command/provider-command protocol. The legacy runtime had stronger agent
capabilities around ACP sessions, continuation, cancellation, schema prompting,
JSON recovery, permission modes, and telemetry.

The important product correction is that `acpx` is not just one provider
command. `acpx` is the headless ACP client and session executor that hides the
complexity of talking to ACP-compatible coding agents. Acpus should treat acpx
as the first-class execution backend for agent turns, while Acpus continues to
own workflow scheduling, durable retry, frozen IR, artifacts, fork/replay, and
runtime controls.

The desired architecture is:

```text
Acpus runtime
  owns: frozen IR, scheduler-visible attempts, pause/fork/replay, runtime
        agent-node execution behavior, run-local artifacts, public read
        projections

@acpus/agent-executor
  owns: one resolved acpx-backed ACP agent turn and its normalized result

acpx
  owns: ACP session lifecycle, ACP agent subprocess management, queueing,
        cooperative cancel, reconnect, raw ACP JSON stream, builtin agent
        registry, and --agent custom ACP server escape hatch
```

## Goal

Replace the raw command-backed agent execution model with an acpx-backed ACP
agent executor and a complete runtime-owned agent-node execution path.

The delivered state should make every real agent execution path go through
acpx:

- `agent.use` selects an acpx positional agent token such as `codex`, `claude`,
  `pi`, `openclaw`, or an acpx-configured agent name.
- `agent.command` selects acpx `--agent <command>` for a custom ACP server
  command. It is not a generic shell worker protocol.
- `@acpus/agent-executor` depends on the workspace package's pinned acpx
  dependency and resolves that bundled CLI internally. The public API does not
  expose an acpx path or command override.
- Each scheduler-visible agent attempt may execute multiple acpx turns inside
  runtime's agent-node execution layer: one initial turn plus bounded
  response repair turns.
- Agent response repair is not scheduler-visible retry. It is an
  agent-node execution concern that keeps using the same acpx session and
  records each turn as auditable runtime metadata.
- Users can see every failed repair turn through turn artifacts and
  telemetry, while scheduler core sees one leaf attempt that eventually
  completes, fails, is cancelled, or times out.

## Fixed Decisions

- **Execution backend:** acpx is the first-class ACP executor backend for
  agents. Raw shell command execution is not the primary agent abstraction.
- **Custom agents:** `agent.command` means acpx `--agent <command>`.
- **Dependency:** `@acpus/agent-executor` uses an internal acpx dependency only.
  Tests may use internal fakes, but public runtime behavior is not configured
  through `PATH`, `ACPUS_ACPX_COMMAND`, or provider-command env mappings.
- **Permission mode name:** replace `policy?: "read" | "full"` with
  `permissionMode?: "approve-reads" | "approve-all" | "deny-all"` on agent
  definitions and agent runs.
- **Permission mode default:** absent node-level and definition-level
  `permissionMode` defaults to `approve-all`. This intentionally differs from
  acpx's own `approve-reads` default so Acpus preserves the previously decided
  "full permission by default" behavior.
- **Permission mode mapping:** `approve-all` maps to acpx `--approve-all`;
  `approve-reads` maps to acpx `--approve-reads`; `deny-all` maps to acpx
  `--deny-all`. Runtime resolves and passes the normalized `permissionMode`
  value; `@acpus/agent-executor` maps that value to explicit acpx flags so
  frozen run behavior is not determined by user-local acpx config. This mapping
  only commits to passing the explicit acpx permission-mode flag. Acpus must not
  define an additional non-interactive permission policy contract in this goal.
- **Permission boundary:** `permissionMode` controls how acpx answers ACP
  permission requests. It is not OS sandboxing, not task isolation, and not
  acpx's per-tool `--policy`/`--permission-policy` JSON.
- **Agent session mode:** add `agentMode?: string` to agent definitions for
  both named and custom command agents. It maps to ACP `session/set_mode`
  through acpx `set-mode`; values are adapter-defined and are not enumerated by
  Acpus. Runtime validates only that the rendered value is non-empty when
  provided. Unsupported values fail clearly as `config`.
- **Agent mode scope:** `agentMode` is definition-level in this goal. Do not add
  a node-level override unless a later authoring decision introduces one. If a
  workflow needs the same backend in multiple modes, it should declare multiple
  agents.
- **Agent response repair level:** schema-backed agent response repair is
  runtime agent-node execution behavior, not scheduler-visible retry. It
  continues the same acpx session with repair/continuation prompts. The repair
  loop covers output conformance failures and successful-but-empty agent
  responses; those remain distinct runtime classifications. This is an
  intentional legacy-aligned behavior: retry means "ask the same agent session
  to repair/continue its answer", not "rerun the workflow leaf from scratch".
  Successful-but-empty responses are included because, once acpx reports the
  turn itself succeeded and the session remains usable, an empty response is an
  agent-output problem rather than a tool-layer failure. Backend/tool-layer
  failures still bypass repair and fail directly.
- **Retry API:** workflow `retry` is not a generic leaf auto-retry mechanism.
  For this goal it only controls schema-backed agent response repair budget.
- **Retry shape:** V1 keeps only `retry.max`. Do not introduce public
  `retry.on` or `retry.backoff`.
- **Retry default:** schema-backed agent nodes default to `retry.max = 2`,
  meaning one initial turn plus up to two repair turns. Repair turns wait a
  fixed internal 5 seconds after the failed turn and before the next repair
  turn; this delay is not configurable.
- **Task retry:** task nodes do not participate in workflow-level automatic
  retry in this goal. Manual control-plane retry remains separate.
- **Output failure abstraction:** JSON recovery failure and SchemaIR validation
  failure are both `output_conformance` at the runtime contract level. Empty
  response text from an otherwise successful acpx turn is `empty_response`, not
  `output_conformance` and not a JSON parse failure. The implementation may
  keep internal detail such as `json_recovery`, `schema_validation`, or
  `empty_response` for diagnostics. `empty_response` is repairable only when
  the acpx turn itself succeeded; backend/tool-layer errors with empty response
  text must fail directly and must not be hidden behind response repair.
  This intentionally refines legacy's old raw-command implementation, which
  treated empty schema-backed output as an infrastructure-style failure to
  avoid masking acpx/agent startup errors. In the acpx-backed design, the
  executor is responsible for classifying backend/tool failures first; runtime
  may then repair only a successful-but-empty agent answer.
- **Agent options:** remove broad `options?: JsonObject` from agent definition
  authoring and IR. Future acpx capabilities must be added as explicit typed
  Acpus fields.
- **Agent overrides:** support submit-time and fork-time agent overrides.
  Overrides apply only to declared top-level agent definitions and use the same
  typed contract as agent definitions: identity (`use` or `command`), `model`,
  `cwd`, `env`, `permissionMode`, and `agentMode`. Overrides must not accept
  broad `options`. Forked runs inherit effective overrides unless the fork
  request replaces them. When an override changes the agent identity, inherited
  identity-tied fields such as `model` and `agentMode` should be cleared unless
  the override supplies replacements; `permissionMode` remains orthogonal to
  identity.
- **Command model:** `AgentCommandSpec` may declare `model`. For command
  agents, the model is applied through acpx/ACP model control. It is not
  appended to the command string; custom ACP servers that do not advertise
  model support fail at runtime if a model is requested. If acpx reports an
  unsupported model/capability negotiation failure, normalize it as `config`;
  opaque process exits may still classify as `provider_exit`.
- **Mock boundary:** mock execution is a hermetic test/local fixture tool, not
  a public provider abstraction. Public authoring must not treat `use: "mock"`
  as a real agent backend.
- **Mock-agent boundary:** do not revive the legacy full ACP mock-agent package
  for the current acpx-backed runtime or for ordinary e2e coverage. That
  package tested ACP stdio/session lifecycle behavior (`initialize`,
  `session/new`, `session/load`, `session/prompt`, `session/update`,
  `session/cancel`, streaming, hangs, crashes, and traces). Current Acpus
  runtime does not own that protocol surface. If this goal keeps acpx as the
  ACP owner, tests should fake the acpx process boundary rather than implement
  an ACP server. A full ACP mock agent becomes justified only if
  `@acpus/agent-executor` directly implements or validates ACP wire behavior.
- **Old execution paths:** all real runtime entry points must converge on the
  acpx-backed agent path. Existing provider-command fallback paths must be
  removed, redirected, or made clearly unreachable before this goal is complete.
- **Compatibility:** this is a greenfield breaking change. Do not add legacy
  raw-command compatibility shims unless explicitly requested.

## Interface Direction

`@acpus/agent-executor` keeps a small public surface but changes the resolved
request shape from raw shell command execution to acpx-backed turn execution.

Expected package exports:

- `executeAgentTurn(request)` or an equivalently narrow turn-level function
- public request/result/error types for acpx-backed resolved turns
- deterministic mock request support only for hermetic tests and local runtime
  fixtures, not as the real provider abstraction

Expected package removals or demotions:

- `getProviderCommandFromEnv(...)` should leave the current product path.
  Provider command mappings are replaced by acpx agent tokens, acpx config, and
  acpx `--agent`.
- raw command request kinds should not remain the public agent execution path.

Resolved acpx request fields should include:

- agent selector: named acpx agent token or custom `--agent` command
- rendered prompt
- absolute cwd
- rendered acpx session name
- effective permission mode
- optional model
- optional agent mode
- optional timeout
- process env to pass through to acpx
- abort signal
- normalized telemetry callback for the current turn

Runtime passes resolved workflow values such as permission mode, model, cwd,
agent mode, env, and session. It must not pass raw acpx CLI flags. The executor
package owns acpx CLI grammar, flag construction, stream parsing, and ACP wire
details.

Resolved acpx requests must not include workflow schema or retry policy. The
executor package does not know `SchemaIR`, does not recover workflow JSON
output, does not validate workflow output, and does not decide whether to send a
repair prompt.

Resolved acpx results should be returned as classified values rather than
throwing for ordinary execution failures:

- `completed`: includes response text, stderr, acpx record/session metadata
  when available, cwd, and final normalized telemetry facts.
- `failed`: includes a stable infrastructure/backend `failureKind`, message,
  response text when any, stderr, metadata, and final normalized telemetry
  facts.
- `cancelled`: represents scheduler/operator cancellation and must not be
  retried as an ordinary failure.

Stable failure kinds should include at least:

- `config`
- `spawn`
- `provider_exit`
- `timeout`
- `output_overflow`

`cancelled` is a result status, not a failure kind. `output_conformance` and
`empty_response` belong to runtime agent-node execution after an acpx turn has
completed successfully enough to produce a response decision. Detectable backend
or tool-layer errors must stay executor/backend failures and must not enter
agent response repair.

Timeout classification has two layers:

- When a node timeout is configured, scheduler attempt timeout is the total
  budget for one scheduler-visible agent attempt, including all acpx turns and
  fixed repair delays.
- Runtime should pass the remaining finite attempt budget to each acpx turn. A
  turn timeout caused by exhausting that budget maps to scheduler `timed_out`.
- A future shorter per-turn timeout, if introduced, is an executor
  `timeout`/infrastructure failure and is not a response repair trigger.

The executor owns all ACP wire parsing. Runtime must never parse raw ACP JSON
lines or rely on ACP protocol shapes. Optional raw ACP debug material, if kept,
is an opaque debug artifact produced by the executor/runtime integration, not a
runtime decision input.

## Runtime Integration

Runtime remains responsible for workflow semantics around agent nodes:

- Render `node.run.prompt`, `node.run.cwd`, `node.run.env`, and
  `node.run.session.key` from frozen IR and durable execution scope.
- Persist and restore enough dynamic execution scope for agent leaves so
  pause/resume and manual retry inside fanout, loop, parallel, or nested frames
  can re-render prompt, cwd, env, and session key without re-deriving parent
  execution. Persist only value context needed for rendering, not large artifact
  payloads.
- Build the acpx session name:
  - explicit session keys are rendered, required to be non-empty, and encoded
    without lossy normalization collisions;
  - absent session keys derive from run id and dynamic `nodeKey`.
- Resolve effective permission mode as
  `node.run.permissionMode ?? definition.permissionMode ?? "approve-all"`.
- Resolve cwd as `node.run.cwd ?? definition.cwd ?? run cwd`.
- Resolve model from the agent definition. Do not add a node-level model
  override in this goal unless a separate authoring decision introduces one.
- Resolve agent mode from the agent definition. Do not add a node-level mode
  override in this goal.
- Merge env in this order: host process env, definition env, node env, then
  runtime-owned `ACPUS_RUNTIME_*` values and other executor-required values.
  Runtime-owned values overwrite stale host values.
- Resolve `agent.use` to an acpx positional agent token.
- Resolve `agent.command` to acpx `--agent <command>`.
- Pass model, agent mode, cwd, timeout budget, env, runtime identity,
  normalized permission mode, and each prepared prompt to the executor.
- Append an output schema section to the prompt when `outputSchema` exists,
  using the current SchemaIR-to-JSON-Schema lowering from `@acpus/core`.
- Run bounded agent response repair when schema-backed output cannot be
  recovered or accepted, or when an otherwise successful schema-backed turn
  produces empty response text.
- Recover and conform structured output through the agent output conformance
  helper.
- Classify final exhausted recovery or validation failure as
  `output_conformance`, not as a generic thrown runtime error.
- Classify final exhausted empty responses as `empty_response`.
- Persist per-turn prompt, response, stderr, and telemetry artifacts for every
  acpx turn inside the scheduler-visible attempt.
- Persist and expose both the rendered explicit session key, when one exists,
  and the encoded acpx session name used for execution.

The current runtime-owned `ACPUS_RUNTIME_*` scrub/overwrite rule still applies.
No host-provided stale runtime identity may leak into acpx or its child agent.

### Prompt Policy

For schema-backed agent nodes, prompt construction must align with the legacy
contract. The fixed continuation prompt is exactly:

```text
Continue the previous task from where you left off.
```

- first prompt: rendered task prompt plus the output schema section;
- response repair prompt: fixed continuation prompt plus the output schema
  section;
- plain continuation prompt: fixed continuation prompt only.

The output schema section must state that after completing the task, the final
response must be exactly one JSON value that conforms to the schema, with no
Markdown or prose. For object schemas, it must also state that extra keys are
accepted but are not available to later workflow expressions. The section then
includes the SchemaIR-derived JSON Schema.

Previous output conformance or empty-response error details belong in runtime
diagnostics and artifacts. They must not be injected into the repair prompt in
this goal. This is a legacy prompt compatibility requirement: repair turns use
the stable continuation-plus-schema prompt, not a dynamically expanded prompt
that includes parse errors, validation errors, or empty-response messages.

Plain continuation after manual control-plane retry, or after pause/resume of a
requeued agent node, must reuse the same acpx session identity and send only
the fixed continuation prompt. It must not duplicate the full original prompt
and must not append the schema contract. The original task and schema
instructions are expected to remain in the ACP session. Requeued-agent
pause/resume and manual control-plane retry are not agent response repair turns
and do not consume `retry.max`. A control-plane rerun that creates a new
scheduler-visible attempt gets its own agent response repair budget.

### Agent Session Mode

`agentMode` is an Acpus name for adapter-defined ACP session modes. It is not
the same as `permissionMode`, not an acpx session lifetime mode, and not a
workflow scheduler mode.

Every acpx turn must ensure the target session exists before sending a prompt.
This aligns with legacy's idempotent `sessions ensure` contract and lets acpx
own saved-session recovery.

When `agentMode` is present, `@acpus/agent-executor` must ensure the acpx
session exists, call acpx `set-mode` for the resolved session before the initial
prompt turn, then send the prompt. Repair and plain-continuation turns must
ensure the session again before prompt, but must not reapply `set-mode` unless a
future acpx API makes idempotent per-turn mode application necessary.

Unsupported or rejected agent modes are configuration failures. Runtime must not
start agent response repair for a failed `set-mode`, because no prompt turn
has produced output to repair.

Implementation should include a short non-normative comment near the public
`agentMode` type or acpx mode mapping with the currently known values. This list
is documentation for authors and maintainers, not a validation enum:

| Agent | Known session mode |
| --- | --- |
| `claude` | `default` |
| `claude` | `acceptEdits` |
| `claude` | `dontAsk` |
| `claude` | `bypassPermissions` |
| `claude` | `auto` |
| `claude` | `plan` |
| `codex` | `read-only` |
| `codex` | `agent` |

### Agent Output Conformance

Agent output conformance is a helper called by runtime agent-node execution.
It owns response JSON recovery, conservative repair, schema acceptance,
extra-key projection, and conformance diagnostics for schema-backed agent
outputs. This behavior must not be encoded into `WorkflowIR`, must not change
general runtime `normalizeValue(...)` semantics for non-agent outputs, and must
not leak into scheduler core.

The helper must retain the functional recovery behavior that made legacy agent
retry useful: prose-wrapped JSON, Markdown-fenced JSON, balanced embedded
objects/arrays, and conservative JSON repair are all attempted before a turn is
classified as `output_conformance`. Removing that recovery would turn
repairable agent formatting drift into hard failures and would be a functional
regression from legacy. This recovery/repair behavior is required for the
schema parsing module itself; runtime and IR should consume only its semantic
result rather than reimplementing parser-specific branching.

- Strict whole-response JSON parse is the fast path.
- If strict parse fails, scan balanced object/array candidates from prose and
  Markdown code fences.
- Prefer the latest valid candidate, while avoiding bracket fragments from prose
  or code examples that are not plausible final JSON.
- Repair only object-shaped candidates with a conservative JSON repair fallback.
- Non-schema agents return `{ text }` from response text rather than requiring
  JSON.

For schema-backed agents, the helper returns both:

- `rawRecoveredOutput`: the parsed/repaired JSON value before projection, for
  diagnostics, telemetry, and artifacts.
- `conformedOutput`: the workflow-visible value after schema acceptance and
  projection.

Schema-backed agent output uses permissive extra-key acceptance with narrow
projection. Extra object keys do not fail conformance solely because they are
not declared. The workflow-visible `conformedOutput` must be projected to the
declared schema shape, with undeclared object keys removed and declared fields
validated/applied according to the schema. Dynamic keys remain only where the
schema itself allows them, such as record schemas, unknown schemas, or explicit
additional-properties support. Runtime node output and expression scope receive
only `conformedOutput`; raw recovered output may be retained in diagnostics and
artifacts for inspection.

### Empty Agent Responses

For schema-backed agent nodes, an otherwise successful acpx turn that produces
empty response text is classified as `empty_response`. It is not
`output_conformance` and must not enter JSON parsing.

`empty_response` must be repairable with the same schema-backed agent response
repair budget when all of these are true:

- the acpx process/turn completed successfully;
- session setup succeeded and the same acpx session can be reused;
- cancellation was not requested;
- no detectable backend/tool-layer error was reported by acpx.

Repair uses the same session, the fixed internal delay, and the legacy-aligned
response repair prompt. Backend/tool-layer failures remain direct failures and
must not be retried as agent response repair and must not be reclassified as
`empty_response`. This includes session ensure failure, set-mode failure, spawn
failure, timeout, non-zero provider exit, output overflow, and detectable
JSON-RPC/backend error output. If both empty response text and a detectable
backend/tool-layer failure are present, the backend/tool-layer failure wins.
The runtime must preserve enough bounded error detail for users to understand
the direct failure through metadata, artifacts, or CLI inspection.

Every empty-response repair decision must be auditable. The empty turn must
produce normal turn metadata and artifacts before the next repair turn starts,
including the rendered prompt, empty response artifact or explicit empty
response marker, telemetry when available, and `empty_response` classification.
Users must be able to distinguish "the agent answered with nothing and Acpus is
repairing it" from "acpx or the backend failed and Acpus stopped immediately".

## Agent Response Repair And Retry

This goal preserves the durable scheduler design decision that schema-backed
agent response repair is runtime agent-node execution detail, not a
scheduler-visible attempt. The decision is intentionally retained because
legacy retry is not a generic rerun: it is an agent-specific continuation
protocol that sends a repair prompt into the same ACP session.

Mechanism:

- Scheduler starts one durable leaf attempt for the agent node.
- Runtime agent-node execution runs one initial acpx turn.
- If the node has an `outputSchema` and the turn's final response cannot be
  recovered as acceptable structured output, or the turn is classified as
  `empty_response`, runtime records the failed turn and may send another repair
  turn in the same acpx session.
- The repair loop ends when one turn yields `conformedOutput`, the repair
  budget is exhausted, the scheduler attempt times out, or cancellation is
  requested.
- Scheduler receives exactly one final attempt result: completed, failed,
  timed out, or cancelled.

Retry API:

- `retry.max` means additional schema-backed agent response repair turns after
  the initial turn.
- If omitted on a schema-backed agent node, runtime uses `retry.max = 2`.
- `retry.max = 0` disables schema-backed agent response repair, including
  `empty_response` repair.
- `retry` is invalid on agent nodes without `outputSchema`.
- `retry` is invalid on task nodes for this goal.
- `retry.on` and `retry.backoff` are not part of the V1 API.
- Runtime waits a fixed internal 5 seconds before each repair turn. This is an
  implementation policy, not a workflow field. The delay is abortable and
  counts against the scheduler attempt timeout budget.

Failure classification:

- `output_conformance` is the stable runtime failure kind for exhausted agent
  output contract failures.
- `empty_response` is the stable runtime failure kind for exhausted
  successful-but-empty schema-backed agent responses.
- Runtime may attach diagnostic detail such as `json_recovery` or
  `schema_validation`, plus a human-readable validation message.
- `config`, `spawn`, `provider_exit`, `timeout`, and `output_overflow` are not
  response repair triggers.
- A successful-but-empty schema-backed turn is the only empty-output case that
  may enter repair. Detectable backend/tool-layer failures with empty text
  remain backend failures and must not be counted against `retry.max`.
- Cancellation is not a failure kind and does not enter repair policy.

Manual control-plane retry remains separate. `acpus runs retry` can still rerun
a failed node or run through scheduler controls, but workflow DSL `retry` does
not mean generic automatic leaf rerun. For agent nodes, manual retry follows the
plain continuation prompt contract above: same acpx session identity, fixed
continuation prompt, no schema contract appended solely because the node is
schema-backed.

## Timeout And Cancellation Boundaries

When a node timeout is configured, one scheduler-visible agent attempt has one
total timeout budget. Runtime agent-node execution must apply that budget across
the initial turn, fixed repair delays, repair turns, artifact writes that are
part of the attempt, and cooperative cancellation cleanup.

Cancellation is control-plane state, not a retryable failure. When cancellation
is requested, runtime should abort any repair delay, ask the executor to cancel
the active acpx turn cooperatively, persist whatever prompt/response/telemetry
material is already available, and report a cancelled attempt result.

The executor may expose `timeout` for an individual acpx turn result, but
runtime owns the mapping from remaining scheduler budget to final scheduler
`timed_out` status.

## Observability And Artifacts

Agent attempts must become auditable without turning repair turns into
scheduler attempts.

Per scheduler-visible agent attempt, runtime should persist an aggregate
manifest or metadata record for:

- acpx session identity and cwd
- rendered explicit session key when declared, plus encoded acpx session name
- current turn number
- final accepted output or terminal failure summary
- latest context usage when available
- references to per-turn prompt, response, stderr, and telemetry artifacts

Structured attempt/turn metadata should live in a runtime-owned metadata record
such as `execution_metadata`, with file-like material in the existing artifact
registry. Public read projections should expose compact agent attempt/turn
metadata, or an equivalent stable shape, without forcing clients to parse raw
logs. If the current scheduler attempt error model only stores a reason string,
implementation must either extend the attempt error payload or pair the reason
with structured runtime metadata before CLI/read surfaces claim detailed
failure support.

Per acpx turn, runtime should persist run-local artifacts for:

- rendered prompt
- response text
- stderr diagnostics when present
- compact telemetry JSON
- optional raw ACP debug stream, disabled by default

Telemetry should be produced by `@acpus/agent-executor` from acpx output and
passed to runtime as normalized facts:

- assistant response chunks
- stop reason
- context usage
- token usage
- recent tool calls, bounded by count and with raw tool payloads omitted
- acpx record/session metadata when acpx exposes it
- effective cwd

Runtime must not parse raw ACP JSON lines. Raw ACP debug output, if enabled, is
opaque debug material and not a scheduler or retry input.

Raw ACP debug artifacts are enabled only through the diagnostic environment
switch `ACPUS_AGENT_RAW_ACP_DEBUG=1`. The switch is intentionally not workflow
authoring state and must not affect retry, scheduling, or conformance decisions.

Artifacts should use the existing run-local artifact registry and dynamic
`nodeKey` plus scheduler `attemptNo`, with a nested turn identity such as:

- `attempt-001/turn-001.prompt.md`
- `attempt-001/turn-001.response.md`
- `attempt-001/turn-001.telemetry.json`
- `attempt-001/turn-001.stderr.log`
- `attempt-001/agent-telemetry.json`

Turn telemetry accumulators should be independent. The acpx session is reused
across repair turns; telemetry records are not. The attempt aggregate may expose
latest session context and a list of turns, but token usage should only be
summed if acpx explicitly reports per-turn deltas. Otherwise preserve per-turn
values without inventing totals.

Agent telemetry/artifacts are runtime metadata, not scheduler semantic state.
Scheduler reducers must not depend on telemetry or artifact contents.

Public read APIs must expose enough information for CLI inspection surfaces to
later show a user:

- the node is repairing output because the agent returned invalid structured
  output;
- which turn failed and why;
- where to inspect prompt/response/telemetry artifacts;
- when the repair budget is exhausted and the node becomes failed.

## Workstreams

### Phase Progress

- [x] Phase 1: Core API/IR cleanup landed for agent definition/run authoring
  and IR shape. Scope: remove `policy`/`options`, add
  `permissionMode`/`agentMode`, allow `AgentCommandSpec.model`, make retry
  `max`-only, reject task workflow-level retry, and reject agent retry without
  `outputSchema`.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about
    authoring-path silent drops, dead task retry loop structure, and weak retry
    validator oracle were addressed in this phase.
  - Remaining gap: runtime still uses the old provider-command/raw shell agent
    path and scheduler-visible agent retry. Those are intentionally left for
    later phases and are not marked complete below.
- [x] Phase 2: `@acpus/agent-executor` acpx turn backend landed. Scope:
  bundled acpx dependency resolution, named/custom agent acpx args,
  `sessions ensure`, `prompt -s ... -f -`, `set-mode`, permission/model/cwd/env
  propagation, timeout/cancel handling, bounded output, JSON-RPC response/error
  parsing, classified backend results, and temporary legacy helper compatibility
  while runtime migration is still open.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about real acpx
    JSON shape, malformed JSON stdout, JSON-RPC error leakage, too-fast
    SIGKILL fallback, ensure-time config classification, weak argv/failure
    tests, result type coverage, and legacy provider-command fail-fast behavior
    were addressed in this phase.
  - Remaining gap: runtime still has not been moved to `executeAgentTurn`, so
    runtime-owned repair, artifacts, read projections, and removal of provider
    command helpers remain open.
- [x] Phase 3: runtime agent execution core migrated to acpx turn execution.
  Scope: scheduler and non-scheduler runtime paths call `executeAgentTurn`,
  provider-command env mappings are no longer used by real runtime agent paths,
  runtime-owned prompt/cwd/env/session/permission/model/mode resolution is in
  place, schema-backed response repair runs inside one scheduler attempt,
  empty responses and output conformance failures are repairable, extra object
  keys are projected according to schema visibility, and agent turn timeouts map
  to scheduler `timed_out`.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about misplaced
    test seams, scheduler timeout mapping, recursive extra-key projection,
    non-scheduler session run identity, and provider-command test wording were
    addressed in this phase.
  - Remaining gap: per-turn artifacts, structured attempt metadata/read
    projections, manual plain-continuation retry semantics, and submit/fork
    agent overrides remain open.
- [x] Phase 4: scheduler-backed agent observability landed. Scope: each acpx
  turn writes prompt, response, stderr when present, and telemetry artifacts
  under the scheduler attempt path; agent attempts write structured
  `agent_attempt` execution metadata with turn artifact refs, status, encoded
  acpx session name, and rendered explicit session key when declared; `getRun`
  exposes those metadata rows without involving scheduler reducers.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about
    runtime-local timeout/cancel metadata gaps, zero-turn setup failure
    metadata, weak metadata test oracles, failure-path observability coverage,
    and visualization overlay type coupling were addressed in this phase.
  - Remaining gap: submit/fork agent overrides, manual control-plane plain
    continuation retry semantics, raw ACP debug artifacts, and CLI/follow
    rendering remain open.
- [x] Phase 5: manual control-plane agent retry continuation landed. Scope:
  node retry attempts receive the scheduler retry status reason, agent runtime
  maps that to the fixed plain continuation prompt for the retried attempt's
  initial acpx turn, the schema section is not appended to that initial manual
  retry prompt, and the session identity remains derived from the same run id
  plus dynamic node key.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about
    plain-continuation retries reapplying `agentMode`, broad scheduler
    `statusReason` leakage, pause/resume overclaiming in docs, and missing
    run-level retry counter-coverage were addressed in this phase.
  - Remaining gap: submit/fork agent overrides, pause/resume plain
    continuation semantics, raw ACP debug artifacts, raw recovered output
    diagnostics/artifacts, and CLI/follow rendering remain open.
- [x] Phase 6: submit/fork agent overrides landed. Scope: run admission stores
  typed override metadata separately from frozen `WorkflowIR`, frozen run reads
  apply effective agent definitions for execution, `getRun` exposes durable
  overrides, fork inherits source overrides and merges fork-time replacements,
  identity changes clear inherited `model`/`agentMode` unless replacements are
  supplied, `permissionMode` remains inherited, and CLI accepts `--agents`
  JSON for `run` and `runs fork`.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about
    fork-time partial overrides dropping unrelated inherited overrides,
    unknown override fields being silently ignored, missing invalid override
    coverage, and missing CLI `--agents` usage/control coverage were addressed
    in this phase.
  - Remaining gap: pause/resume plain continuation semantics, raw ACP debug
    artifacts, raw recovered output diagnostics/artifacts, and CLI/follow
    rendering remain open.
- [x] Phase 7: raw recovered schema-backed agent output diagnostics landed.
  Scope: runtime conformance returns the recovered raw JSON value separately
  from schema-projected `conformedOutput`, scheduler-backed turns write
  `turn-XXX.raw-output.json` artifacts whenever JSON recovery succeeds, and
  agent attempt turn metadata exposes the raw recovered output artifact ref.
  Workflow-visible node output and expression scope still receive only
  `conformedOutput`.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about missing
    scheduler-backed negative coverage for unrecoverable JSON and empty
    responses not writing raw output artifacts were addressed in this phase.
  - Remaining gap: pause/resume plain continuation semantics, raw ACP debug
    artifacts, and CLI/follow rendering remain open.
- [x] Phase 8: raw ACP debug artifacts landed. Scope:
  `ACPUS_AGENT_RAW_ACP_DEBUG=1` makes runtime request executor raw debug
  capture for scheduler-backed agent turns; executor returns bounded raw acpx
  prompt stdout as opaque debug material; runtime writes
  `turn-XXX.raw-acp.jsonl` artifacts and exposes turn metadata refs. The raw
  stream is not parsed by runtime and does not affect scheduling, response
  repair, conformance, or replay decisions.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about runtime
    raw debug artifact writes needing their own host-switch gate, non-`1`
    switch values missing negative coverage, and failed-turn raw debug coverage
    were addressed in this phase.
  - Remaining gap: pause/resume plain continuation semantics and CLI inspection
    rendering remain open.
- [x] Phase 9: CLI agent repair history rendering landed. Scope: text
  `acpus runs show` and `acpus runs status` output renders runtime
  `agent_attempt` execution metadata, including attempt status, session,
  per-turn status, failure kind, message, and artifact paths for prompt,
  response, stderr, telemetry, raw recovered output, and raw ACP debug when
  present. JSON output remains the unchanged full runtime read projection. The
  current CLI has no separate streaming follow command; this phase covers the
  existing inspection surfaces.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about incomplete
    artifact-label coverage, missing malformed metadata coverage, missing JSON
    preservation coverage, and stale `follow/show` roadmap wording were
    addressed in this phase.
- [x] Phase 10: pause/resume agent continuation landed. Scope: scheduler
  restart context distinguishes paused requeue restarts from normal task
  starts, runtime maps that context to the fixed plain continuation prompt for
  agent nodes, the schema section is not appended, `agentMode` is not reapplied,
  and the same deterministic acpx session identity is reused for the dynamic
  node key.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about manual
    node retry not reopening failed scheduler runs, stale dynamic node-key
    artifact test oracles, pause/resume coverage bypassing the real scheduler
    chain, broad roadmap wording, and parent group members not reopening for
    control retry of failed leaves inside multi-node branches were addressed in
    this phase.
  - Remaining gap: no known Phase 10 gap.
- [x] Phase 11: final legacy public-surface cleanup landed. Scope:
  `@acpus/agent-executor` no longer exports legacy raw-command
  `executeAgentRequest`, provider-command env parsing, or
  `AgentProviderRequiredError`; public API/type tests and
  `specs/agent-executor-spec.md` now describe only the resolved acpx turn API;
  a narrow hermetic acpx process integration verifies runtime duration strings
  are converted to acpx positive-second `--timeout` values.
  - Review: two subagents completed adversarial review for
    correctness/soundness, Clean Code, and Good Test. Findings about acpx
    timeout argument units, missing timeout process-boundary coverage,
    post-completion abort listeners cancelling reusable sessions, pending
    Phase 11 review wording, stale provider-command roadmap text, and ambiguous
    core spec provider/command wording were addressed in this phase.
  - Remaining gap: no known Phase 11 gap.

### A. Spec Delta Tracking

- Keep this implementation goal in `docs/roadmap/` until behavior exists.
- Do not update `specs/` ahead of implementation. Specs are current product
  truth under this repository's `AGENTS.md`.
- For each implementation slice, land implementation, tests, and the relevant
  spec delta in the same change. Specs must not describe behavior before it
  exists, and behavior must not be handed off without the matching current spec.
- Expected final spec deltas include:
  - `specs/agent-executor-spec.md`: acpx-backed ACP turn execution instead of
    raw command/provider-command execution.
  - `specs/runtime-spec.md`: runtime-owned agent-node response repair,
    schema-backed agent output projection, submit/fork agent override
    execution, per-turn artifacts, telemetry, and scheduler attempt boundaries.
  - `specs/cli-spec.md`: `run --agents` and `runs fork --agents` wiring for
    typed runtime agent overrides.
  - `specs/core-spec.md`: `agent.command` means acpx `--agent`, broad agent
    `options` is removed, `policy` is renamed to `permissionMode`,
    `agentMode` is added as a definition-level adapter-defined session mode,
    `AgentCommandSpec.model` is allowed, submit/fork agent overrides use the
    typed agent definition contract without `options`, and `retry` is
    schema-backed agent response repair only.

### B. Runtime Entry Point Convergence

- [x] Remove runtime dependencies on `getProviderCommandFromEnv(...)` and provider
  command env mappings from real agent execution paths.
- [x] Ensure scheduler-backed execution and any remaining non-scheduler control
  fallback cannot execute an agent outside the acpx-backed path.
- [x] Update `packages/runtime/src/control/apply-command.ts`,
  `packages/runtime/src/execution/advance.ts`, and scheduler node executor
  paths as needed so old command-backed execution is removed, redirected, or
  fails clearly for unsupported historical runs.
- Keep deterministic mock execution behind test/local fixture seams only.
- [x] Add regression coverage proving `agent.use` does not consult provider-command
  env configuration.

### C. Agent Executor Acpx Backend

- [x] Add acpx as a package dependency of `@acpus/agent-executor`.
- [x] Resolve the bundled acpx CLI internally.
- [x] Implement acpx `sessions ensure`, `prompt -s`, and cooperative `cancel`.
- [x] Run acpx `sessions ensure` before every prompt turn: initial, repair, and
  plain continuation.
- [x] Build acpx arguments for named agents and `--agent` custom commands.
- [x] Apply model, agent mode, cwd, timeout, permission mode, env, and acpx output
  format.
- [x] If `agentMode` is present, ensure the target session exists and call acpx
  `set-mode <agentMode> -s <session>` before the initial prompt turn.
- [x] Classify acpx `set-mode` rejection or unsupported mode errors as `config`;
  do not send the prompt after a failed mode application.
- [x] Stream and parse acpx output without buffering unbounded data.
- [x] Preserve bounded provider error detail from acpx stdout/stderr, including
  JSON-RPC error messages and non-NDJSON stdout tails, without exposing raw ACP
  protocol lines to runtime as decision input.
- [x] Expose normalized telemetry and final turn result. Do not expose raw ACP
  lines to runtime.
- [x] Return classified execution results instead of throwing for normal acpx
  backend failure outcomes.
- [x] Normalize detectable unsupported model/capability negotiation failures as
  `config`; leave opaque child process exits as `provider_exit`.

### D. Runtime Agent-Node Execution

- [x] Render prompt, cwd, env, and session key from frozen IR.
- [x] Persist and restore dynamic value context for agent leaves so pause/resume and
  manual retry can re-render prompt, cwd, env, and session key inside dynamic
  fanout/loop/parallel/nested frames.
- [x] Generate deterministic acpx session names from run id and node identity.
- [x] Apply explicit precedence for permission mode, agent mode, cwd, env, and
  model as described in runtime integration.
- [x] Append schema contract text for schema-backed agent prompts.
- [x] Produce legacy-aligned response repair prompts.
- [x] Produce legacy-aligned plain continuation prompts for manual control-plane
  node retry.
- [x] Produce legacy-aligned plain continuation prompts for pause/resume of
  requeued agent nodes.
- [x] Scrub and set runtime-owned environment variables before invoking acpx.
- [x] Call the agent output conformance helper for balanced JSON recovery,
  conservative JSON repair, schema-backed acceptance, and workflow-visible
  projection.
- [x] Classify exhausted recovery/validation failures as `output_conformance` and
  exhausted repairable empty responses as `empty_response`.
- [x] Treat scheduler attempt timeout as the total budget across all turns and
  repair delays.
- [x] Make fixed repair delays abortable.
- [x] Persist per-turn prompt, response, stderr, telemetry, and attempt aggregate
  metadata.

### E. Core API Cleanup

- [x] Remove `options` from `AgentUseSpec`, `AgentCommandSpec`, and
  `AgentDefinitionIR`.
- [x] Rename agent `policy` to `permissionMode` on authoring specs, run specs, and
  IR.
- [x] Allow `permissionMode` values `approve-reads`, `approve-all`, and `deny-all`.
- [x] Default absent agent `permissionMode` to `approve-all`.
- [x] Add `agentMode?: string` to `AgentUseSpec`, `AgentCommandSpec`, and
  `AgentDefinitionIR`.
- [x] Validate `agentMode` only as a non-empty string when supplied; do not encode a
  mode enum.
- [x] Include the current known mode values as an implementation comment, not a
  validation source.
- [x] Allow `model` on `AgentCommandSpec` and lower it into `AgentDefinitionIR`.
- [x] Add submit/fork agent override types and validation that mirror typed agent
  definition fields and reject `options`.
- [x] Remove or reject `retry.on` and `retry.backoff`.
- [x] Make `retry` invalid on task nodes and on agent nodes without `outputSchema`.
- [x] Keep `retry.max` as the only public retry field.

### F. Agent Observability

- [x] Add runtime helpers for agent attempt and turn artifacts using the existing
  artifact registry.
- [x] Persist prompt, response, stderr, telemetry, and attempt aggregate metadata.
- [x] Enable raw ACP debug files only when `ACPUS_AGENT_RAW_ACP_DEBUG=1`.
- [x] Use structured runtime metadata for attempt/turn manifests and artifact refs;
  avoid storing detailed failure state only in free-form text.
- [x] Attach artifact refs or execution metadata to runtime read projections
  without making scheduler reducers depend on them.
- [x] Expose enough turn failure metadata and artifact/telemetry pointers through
  runtime read APIs.
- [x] Expose agent repair history in CLI inspection output.

### G. Cleanup

- [x] Remove or quarantine obsolete provider command mapping behavior.
- [x] Update tests and docs that treated `agent.command` as a generic shell
  worker.
- [x] Keep deterministic mock execution only where it is a test/local fixture
  tool.
- [x] Do not edit `legacy/` except for reading it as historical reference.

## Completion Gates

- [x] `@acpus/agent-executor` executes named acpx agents through the bundled
  acpx CLI.
- [x] `agent.command` executes through acpx `--agent <command>`.
- [x] Public `@acpus/agent-executor` API no longer exports an external acpx
  path override, provider-command mapping helper, raw-command execution helper,
  or legacy provider-required migration error.
- [x] No real runtime agent path imports or calls provider-command env mapping
  helpers.
- [x] Non-scheduler fallback paths cannot execute agents through the old raw
  command protocol.
- [x] Absent `permissionMode` defaults to `approve-all` and passes explicit
  acpx flags.
- [x] `permissionMode: "approve-reads"` passes acpx `--approve-reads`;
  `permissionMode: "approve-all"` passes `--approve-all`;
  `permissionMode: "deny-all"` passes `--deny-all`; invocations never mix
  mutually exclusive permission flags.
- [x] `permissionMode` does not define additional Acpus non-interactive
  permission semantics beyond explicit acpx permission-mode flag selection.
- [x] `permissionMode` does not pass or synthesize acpx
  `--policy`/`--permission-policy` JSON.
- [x] `agentMode` is accepted on named and custom command agent definitions as
  a non-empty string and is not validated against a hard-coded enum.
- [x] When `agentMode` is present, executor applies acpx `set-mode` to the
  resolved session before the initial prompt turn.
- [x] Failed or unsupported `agentMode` application is surfaced as `config` and
  does not start an agent prompt or response repair loop.
- [x] Runtime renders and validates non-empty explicit session keys, encodes
  them without collisions, and derives deterministic session names when absent.
- [x] Runtime persists and restores dynamic value context for agent leaves so
  pause/resume and manual retry re-render prompt, cwd, env, and session key
  correctly inside dynamic fanout/loop/parallel/nested frames.
- [x] Runtime exposes both rendered explicit session key, when declared, and
  encoded acpx session name through structured agent metadata/read projections.
- [x] Submit-time and fork-time agent overrides support `use` or `command`,
  `model`, `cwd`, `env`, `permissionMode`, and `agentMode`, reject `options`,
  reject fields outside that typed allowlist, and inherit across forks
  according to the frozen run metadata.
- [x] One scheduler-visible agent attempt may perform multiple acpx turns for
  agent response repair, while scheduler projection still records one leaf
  attempt.
- [x] Output JSON recovery failure and SchemaIR validation failure are surfaced
  as `output_conformance` in runtime diagnostics.
- [x] Agent output conformance retains legacy-style recovery before declaring
  `output_conformance`: strict JSON, Markdown/prose candidate extraction,
  balanced object/array scanning, and conservative repair.
- [x] A schema-backed agent turn with empty response text and no backend/tool
  error is surfaced as `empty_response`, does not enter JSON parsing, and is
  repairable with the schema-backed agent response repair budget.
- [x] Backend/tool-layer errors are never reclassified as `empty_response` and
  fail directly without agent response repair, even when the response text is
  empty.
- [x] Empty-response repair decisions are visible through turn metadata,
  artifacts, and CLI/read inspection as agent-output repair, not hidden as a
  generic parse failure or backend failure.
- [x] Schema-backed agent output accepts extra object keys and exposes only the
  schema-projected `conformedOutput` to node output and expression scope.
- [x] Raw recovered schema-backed agent output is retained for
  diagnostics/artifacts when useful.
- [x] A schema-backed agent defaults to one initial turn plus two repair turns
  unless explicit `retry.max` overrides it.
- [x] `retry.max = 0` disables schema-backed agent response repair, including
  `empty_response` repair.
- [x] Repair turns use the same acpx session and wait a fixed internal 5
  seconds between turns; the delay is abortable and counted in the attempt
  timeout budget.
- [x] Every acpx prompt turn runs `sessions ensure` first; `agentMode`
  `set-mode` runs only before the initial prompt turn.
- [x] `retry.on` and `retry.backoff` are not part of public authoring/IR.
- [x] Task nodes do not support workflow-level automatic retry in this goal.
- [x] Agent nodes without `outputSchema` cannot declare `retry`.
- [x] Config failures are not retried.
- [x] Manual control-plane retry for agent nodes reuses the same acpx session
  identity and sends the fixed plain continuation prompt without appending the
  output schema contract.
- [x] Pause/resume restart of requeued agent nodes reuses the same acpx session
  identity and sends the fixed plain continuation prompt without appending the
  output schema contract.
- [x] Pause/cancel sends cooperative acpx cancel and persists partial
  prompt/response/telemetry artifacts when available.
- [x] Each acpx turn writes independent prompt, response, stderr, and telemetry
  artifacts under the scheduler attempt path and registers them in SQLite.
- [x] Attempt-level agent telemetry records the list of turns and latest session
  context without making scheduler reducers depend on artifact contents.
- [x] Runtime never parses raw ACP JSON lines; raw protocol parsing stays inside
  `@acpus/agent-executor`. Phase 2 implements executor-owned parsing; this gate
  is complete now that runtime uses the acpx turn API.
- [x] `options` is removed from agent definition authoring and IR.
- [x] `policy` is removed from agent definition/run authoring and IR in favor
  of `permissionMode`.
- [x] Current known agent session mode values are documented in implementation
  comments without becoming validation constraints.
- [x] `AgentCommandSpec.model` is allowed and applied through acpx/ACP model
  control, not command string mutation.
- [x] Unsupported command-agent model capability failures are surfaced clearly,
  preferably as `config` when acpx exposes enough detail.
- [x] acpx stdout/stderr error extraction preserves bounded human-readable
  provider error detail for failures without leaking raw ACP protocol lines into
  runtime decisions.
- [x] `ACPUS_AGENT_RAW_ACP_DEBUG=1` enables raw ACP debug artifacts; absent or
  other values leave them disabled.
- [x] Public read APIs expose enough turn failure and artifact metadata for
  CLI inspection output to show agent response repair history.
- [x] Schema prompt text follows the runtime contract: final response exactly
  one JSON value, no Markdown/prose, and object-schema extra keys accepted but
  not workflow-visible.
- [x] Response repair prompt text follows the legacy contract: exactly the
  fixed continuation prompt plus the schema section, with no injected parse,
  validation, or empty-response error details.
- [x] Specs are updated only when implementation behavior matches the new
  current product truth.

## Verification Plan

Use hermetic fake acpx scripts/processes. Tests must not call real networked
agents.

Do not build a legacy-style ACP mock-agent for this goal. The acpx CLI/process
is the contract boundary Acpus owns here; ACP session lifecycle compatibility
belongs to acpx or to a future direct ACP client implementation.

Agent executor tests:

- public API contract and type tests for acpx request/result shapes
- named agent argument construction
- custom `--agent` argument construction
- `--model` propagation for named and custom command agents
- bundled acpx resolution through package dependency
- sessions ensure before every prompt turn and failure classification
- prompt execution and normalized telemetry/response extraction
- cooperative cancel on abort
- timeout classification
- output overflow classification
- permission mode flag mapping and default `approve-all`
- permission mode flag mapping does not assert extra Acpus non-interactive
  permission behavior
- permission mode mapping does not use acpx `--policy`/`--permission-policy`
- `agentMode` request propagation for named and custom command agents
- acpx command ordering for mode-backed turns: session ensure, set-mode, then
  prompt
- acpx command ordering for repair/plain-continuation turns: session ensure,
  then prompt, without reapplying set-mode
- `set-mode` rejection classification as `config`
- model/cwd/env propagation
- no raw ACP JSON leakage in the runtime-facing contract
- unsupported command-agent model capability classification when acpx exposes
  that signal
- bounded acpx stdout/stderr error extraction for JSON-RPC errors and
  non-NDJSON stdout tails

Runtime unit/integration tests:

- real agent execution paths do not consult provider-command env mappings
- non-scheduler fallback cannot execute agents through the old raw command path
- prompt rendering with output schema section
- output schema section uses the legacy final-JSON/no-Markdown/extra-key
  wording
- explicit and derived session names
- blank session key config failure before acpx dispatch
- rendered explicit session key and encoded acpx session name are visible in
  structured metadata/read projections
- dynamic value context is persisted and restored for agent repair/continuation
  inside fanout/loop/parallel/nested frames
- runtime-owned environment scrub/overwrite
- JSON recovery from prose/code fences and conservative repair
- schema validation failure -> `output_conformance` repair turn
- JSON recovery failure -> `output_conformance` repair turn
- empty schema-backed agent response with successful backend turn ->
  `empty_response` repair turn without JSON parsing
- backend/tool-layer error with empty response fails directly and does not enter
  `empty_response` repair
- empty-response turn metadata/artifacts expose the failed empty turn before
  the next repair turn starts
- CLI/read inspection can distinguish empty-response repair from direct
  backend/tool-layer failure
- schema-backed agent output with extra object keys succeeds and projects node
  output/expression scope to the declared schema shape
- raw recovered agent output remains available through diagnostics/artifacts
  when retained, without becoming workflow-visible output
- agent response repair uses the same session name
- manual control-plane retry uses the same session name and fixed plain
  continuation prompt without appending the schema section
- pause/resume restart uses the same session name and fixed plain continuation
  prompt without appending the schema section
- each repair turn writes independent prompt/response/telemetry artifacts
- exhausted agent response repair fails the single scheduler-visible attempt
- `retry.max` controls extra response repair turns for schema-backed agents,
  with default 2 and explicit 0 as opt-out
- fixed 5s internal repair delay is used without public backoff config
- fixed repair delay is abortable and counts against the scheduler attempt
  timeout budget
- scheduler attempt timeout is total budget across initial turn and repair turns
- task nodes reject workflow-level `retry`
- agent nodes without `outputSchema` reject `retry`
- `retry.on` and `retry.backoff` are rejected or absent from public types
- agent `options` is absent from authoring and IR
- agent `policy` is absent from authoring and IR; `permissionMode` lowers with
  aligned acpx values
- `agentMode` is present on agent definition authoring and IR, rejects empty
  strings, and does not encode a known-mode enum
- failed `agentMode` application does not enter agent response repair
- `AgentCommandSpec.model` lowers and is passed through acpx model control
- submit/fork agent overrides accept only typed agent fields, reject `options`,
  clear identity-tied inherited `model`/`agentMode` on identity change unless
  replaced, and preserve/inherit effective overrides across forks
- pause/cancel records partial artifacts and cancels acpx cooperatively
- `ACPUS_AGENT_RAW_ACP_DEBUG=1` writes raw ACP debug artifacts and default
  execution does not
- fork/replay ignore telemetry as scheduler semantics but verify registered
  artifacts through existing artifact registry checks

CLI/read tests:

- `getRun` exposes agent turn metadata and artifacts for response repair
- show/status inspection output distinguishes in-progress repair turns from terminal node
  failure
- artifact references or metadata pointers are visible enough for inspection
- detailed response repair failure state is available from structured runtime
  metadata rather than only from free-form logs

## Non-Goals

- No public scheduler package or public scheduler subpath.
- No direct provider-specific agent SDKs in Acpus.
- No raw shell worker compatibility mode for `agent.command`.
- No external acpx path override as public runtime configuration.
- No broad arbitrary `AgentDefinitionIR.options` field. Model, permissionMode,
  cwd, env, session, timeout, retry.max, and custom `--agent` command are the
  supported execution controls for this pass.
- No public per-tool `permissionPolicy` field in this pass.
- No public enum of agent session modes. Known values may be documented in code
  comments, but users remain responsible for supplying adapter-supported
  strings.
- No workflow-level automatic task retry.
- No public retry kind filters or configurable retry backoff.
- No scheduler-visible attempt per response repair turn.
- No runtime hook/injector parity in this goal. Hook support may be designed in
  a later goal.
- No global SchemaIR or runtime `normalizeValue(...)` unknown-key policy change
  for non-agent outputs.
- No legacy YAML workflow compatibility shims.
- No changes to `legacy/`.

## Risks And Constraints

- `acpx` is alpha, so the implementation should pin a compatible version and
  isolate CLI grammar assumptions inside `@acpus/agent-executor`.
- The executor package should remain deep: acpx process/stream/cancel details
  and ACP wire parsing belong inside the package, while workflow scope, JSON
  recovery, schema validation, agent response repair, and artifact persistence
  remain runtime responsibilities.
- Failure and repair metadata must be semantic and stable. Avoid storing
  free-form error text as the only decision input.
- Agent response repair must not leak into scheduler core. Scheduler attempt
  state remains durable leaf-attempt truth; turn history is runtime metadata.
- `AgentCommandSpec.model` depends on ACP model support. Custom agents that do
  not advertise model controls should fail clearly when a model is requested.
- Agent telemetry can be large or noisy. Keep read projections compact, write
  full human-readable material to artifacts, and bound live telemetry summaries.
- Do not make scheduler reducers depend on artifact or telemetry content.

## Final Implementation Gap Audit

Final audit result: no known incomplete implementation gap remains for this
goal after Phase 11 review fixes and full verification.

Implementation differences from the original plan that are intentional and
should not be treated as open gaps:

- `@acpus/agent-executor` accepts runtime timeout duration strings in
  `AgentTurnRequest.timeout` for local process enforcement, but converts them
  to positive integer seconds when constructing acpx `--timeout`, because acpx
  0.11.0 requires seconds.
- Agent-executor integration coverage uses a narrow hermetic acpx process
  smoke test with a local custom `--agent` command that exits before ACP
  initialization. This verifies the real acpx process boundary and timeout flag
  grammar without reviving a full legacy ACP mock-agent.
- `docs/roadmap/durable-runtime-roadmap.md` still contains historical
  provider-command sections, but they are explicitly marked superseded by this
  acpx-backed goal and current specs.
