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
JSON recovery, policy flags, and telemetry.

The important product correction is that `acpx` is not just one provider
command. `acpx` is the headless ACP client and session executor that hides the
complexity of talking to ACP-compatible coding agents. Acpus should treat acpx
as the first-class execution backend for agent turns, while Acpus continues to
own workflow scheduling, durable retry, frozen IR, artifacts, fork/replay, and
runtime controls.

The desired architecture is:

```text
Acpus runtime
  owns: frozen IR, scheduler-visible attempts, retry policy, pause/fork/replay,
        run-local artifacts, public read projections

@acpus/agent-executor
  owns: one resolved acpx-backed ACP agent turn and its classified result

acpx
  owns: ACP session lifecycle, ACP agent subprocess management, queueing,
        cooperative cancel, reconnect, raw ACP JSON stream, builtin agent
        registry, and --agent custom ACP server escape hatch
```

## Goal

Replace the raw command-backed agent execution model with an acpx-backed ACP
agent executor and a scheduler-visible classified attempt retry mechanism.

The delivered state should make every real agent execution path go through
acpx:

- `agent.use` selects an acpx positional agent token such as `codex`, `claude`,
  `pi`, `openclaw`, or an acpx-configured agent name.
- `agent.command` selects acpx `--agent <command>` for a custom ACP server
  command. It is not a generic shell worker protocol.
- `@acpus/agent-executor` depends on the workspace package's pinned acpx
  dependency and resolves that bundled CLI internally. The public API does not
  expose an acpx path or command override.
- Each scheduler-visible agent attempt executes exactly one acpx turn.
- Agent output parse/schema failures are scheduler-visible attempt failures,
  not hidden executor-internal loops and not immediate node failures while retry
  policy still allows continuation.
- Users can see every failed conformance attempt through dynamic attempts,
  artifacts, and telemetry, while the workflow node remains retrying/running
  until retries are exhausted.

## Fixed Decisions

- **Execution backend:** acpx is the first-class ACP executor backend for
  agents. Raw shell command execution is not the primary agent abstraction.
- **Custom agents:** `agent.command` means acpx `--agent <command>`.
- **Dependency:** `@acpus/agent-executor` uses an internal acpx dependency only.
  Tests may use internal fakes, but public runtime behavior is not configured
  through `PATH`, `ACPUS_ACPX_COMMAND`, or provider-command env mappings.
- **Policy default:** absent node-level and definition-level policy defaults to
  `full`.
- **Policy mapping:** `full` maps to acpx full approval mode; `read` maps to
  acpx read-only approval mode. Runtime must pass explicit flags so frozen run
  behavior is not determined by user-local acpx config.
- **Retry level:** output parse/schema retry is scheduler-visible. It continues
  the same acpx session with a repair/continuation prompt.
- **Retry abstraction:** implement classified attempt retry for executor-backed
  leaf nodes. Do not introduce a blanket "all leaf nodes auto retry" rule.
- **Compatibility:** this is a greenfield breaking change. Do not add legacy
  raw-command compatibility shims unless explicitly requested.

## Interface Direction

`@acpus/agent-executor` keeps a small public surface but changes the resolved
request shape from raw shell command execution to acpx-backed execution.

Expected package exports:

- `executeAgentRequest(request)`
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
- effective policy
- optional model
- optional timeout
- process env to pass through to acpx
- abort signal
- JSON expectation flag for schema-backed agents
- stream/telemetry hooks for raw ACP JSON lines and stderr diagnostics

Resolved acpx results should be returned as classified values rather than
throwing for ordinary execution failures:

- `completed`: includes response text, parsed output when requested and
  recovered, stderr, acpx record/session metadata when available, cwd, and
  telemetry facts.
- `failed`: includes a stable `failureKind`, message, response text when any,
  stderr, metadata, and telemetry facts.
- `cancelled`: represents scheduler/operator cancellation and must not be
  retried as an ordinary failure.

Stable failure kinds should include at least:

- `config`
- `spawn`
- `provider_exit`
- `timeout`
- `cancelled`
- `output_parse`
- `output_schema`
- `output_overflow`

## Runtime Integration

Runtime remains responsible for workflow semantics around agent nodes:

- Render `node.run.prompt`, `node.run.cwd`, `node.run.env`, and
  `node.run.session.key` from frozen IR and durable execution scope.
- Build the acpx session name:
  - explicit session keys are rendered, required to be non-empty, and encoded
    without lossy normalization collisions;
  - absent session keys derive from run id and dynamic `nodeKey`.
- Resolve effective policy as `node.run.policy ?? definition.policy ?? "full"`.
- Resolve `agent.use` to an acpx positional agent token.
- Resolve `agent.command` to acpx `--agent <command>`.
- Pass model, cwd, timeout, env, runtime identity, and prompt to the executor.
- Append an output schema section to the prompt when `outputSchema` exists,
  using the current SchemaIR-to-JSON-Schema lowering from `@acpus/core`.
- Validate parsed agent output with runtime `normalizeValue(...)`.
- Classify validation failure as `output_schema`, not as a generic thrown
  runtime error.

The current runtime-owned `ACPUS_RUNTIME_*` scrub/overwrite rule still applies.
No host-provided stale runtime identity may leak into acpx or its child agent.

### Prompt Policy

For schema-backed agent nodes, the first prompt should append an explicit output
contract section. A conformance retry should keep using the same acpx session
and send a repair/continuation prompt that includes:

- a concise instruction to continue the previous task and provide only the final
  structured output;
- the same output schema contract;
- the previous parse/schema error message when available.

Plain continuation after operator pause/resume should not duplicate the full
original prompt unless needed by acpx behavior; the design target is to reuse
the acpx session state.

### Output Recovery

The executor or a package-owned helper should recover structured output from
agent response text with these rules:

- Empty response is an output parse failure when JSON is expected.
- Strict whole-response JSON parse is the fast path.
- If strict parse fails, scan balanced object/array candidates from prose and
  Markdown code fences.
- Prefer the latest valid candidate, while avoiding bracket fragments from prose
  or code examples that are not plausible final JSON.
- Repair only object-shaped candidates with a conservative JSON repair fallback.
- Non-schema agents return `{ text }` from response text rather than requiring
  JSON.

Runtime validation still decides schema acceptance. Extra fields follow current
SchemaIR/runtime policy unless a separate spec change explicitly introduces
legacy-style "persist raw output but expose projected output" behavior.

## Classified Attempt Retry

The scheduler should own retry for executor-backed leaves through a classified
attempt policy.

Mechanism:

- Leaf executors return or throw enough structured information for the runtime
  node executor to commit an attempt with `failureKind`.
- Scheduler projection records each attempt as completed, failed, timed out,
  cancelled, or superseded, with stable error metadata.
- Retry derivation checks failure kind, node kind, and retry policy before
  requeueing a failed dynamic instance.
- Config failures and cancellations are terminal for the current attempt and
  are not automatically retried.

Default policy:

- Agent nodes with an output schema default to automatic conformance retry for
  `output_parse` and `output_schema`.
- The default conformance retry budget is initial attempt plus two retries,
  unless an explicit `retry.max` overrides it.
- Agent nodes without an output schema do not get conformance retry by default.
- Task nodes do not get automatic schema-mismatch retry by default. A task
  output schema mismatch is usually deterministic code failure.
- Explicit task or agent `retry` applies to retryable failure kinds. `retry.on`,
  when supplied, narrows the failure kinds that may requeue.
- Assert and signal nodes are outside this mechanism because they are not
  executor-backed attempts.

This hides control-flow complexity from users without hiding facts: a node may
remain retrying, but each failed conformance attempt is visible in the run's
dynamic attempt history and artifacts.

## Observability And Artifacts

Agent attempts must become auditable at the same level as task attempts.

Per scheduler-visible agent attempt, runtime should persist run-local artifacts
and metadata for:

- rendered prompt
- response text
- stderr diagnostics when present
- compact telemetry JSON
- optional raw ACP debug stream, disabled by default

Telemetry should be derived from acpx `--format json` raw ACP lines where
available:

- assistant response chunks
- stop reason
- context usage
- token usage
- recent tool calls, bounded by count and with raw tool payloads omitted
- acpx record/session metadata when acpx exposes it
- effective cwd

Artifacts should use the existing run-local artifact registry and dynamic
`nodeKey` plus `attemptNo` subpaths. Agent telemetry/artifacts are runtime
metadata, not scheduler semantic state. Scheduler reducers must not depend on
telemetry or artifact contents.

Public read APIs and CLI/follow surfaces should expose enough information for a
user to understand:

- the node is retrying because the agent returned invalid structured output;
- which attempt failed and why;
- where to inspect prompt/response/telemetry artifacts;
- when retries are exhausted and the node becomes failed.

## Workstreams

### A. Specs And Public Contract Alignment

- Update `specs/agent-executor-spec.md` from raw command/provider-command
  execution to acpx-backed ACP turn execution.
- Update `specs/runtime-spec.md` for acpx-backed agents, classified attempt
  retry, conformance retry, artifacts, and telemetry.
- Update `specs/core-spec.md` to state that `agent.command` is acpx `--agent`
  custom ACP server command.
- Remove current provider command env mapping from current product truth.

### B. Agent Executor Acpx Backend

- Add acpx as a package dependency of `@acpus/agent-executor`.
- Resolve the bundled acpx CLI internally.
- Implement acpx `sessions ensure`, `prompt -s`, and cooperative `cancel`.
- Build acpx arguments for named agents and `--agent` custom commands.
- Apply model, cwd, timeout, policy, env, and JSON output mode.
- Stream and parse raw ACP JSON lines without buffering unbounded output.
- Return classified execution results instead of throwing for normal acpx
  failure outcomes.

### C. Runtime Agent Lowering And Prompt/Session Policy

- Render prompt, cwd, env, and session key from frozen IR.
- Generate deterministic acpx session names from run id and node identity.
- Append schema contract text for schema-backed agent prompts.
- Produce repair/continuation prompts for conformance retries.
- Scrub and set runtime-owned environment variables before invoking acpx.
- Validate parsed output and classify parse/schema failures.

### D. Classified Attempt Retry

- Extend scheduler attempt failure metadata to carry stable `failureKind`.
- Teach retry derivation to consult node kind, failure kind, explicit
  `retry.max`, explicit `retry.on`, and agent conformance defaults.
- Ensure each conformance retry is a new scheduler-visible attempt against the
  same acpx session.
- Keep cancellation, pause, stale owner recovery, and timeout semantics
  consistent with existing durable scheduler rules.

### E. Agent Observability

- Add runtime helpers for agent attempt artifacts using the existing artifact
  registry.
- Persist prompt, response, stderr, telemetry, and optional raw ACP debug files.
- Attach artifact refs or execution metadata to attempt/read projections without
  making scheduler reducers depend on them.
- Expose dynamic attempt failure kind and artifact/telemetry pointers through
  read APIs and CLI/follow output.

### F. Cleanup

- Remove or quarantine obsolete provider command mapping behavior.
- Update tests and docs that treated `agent.command` as a generic shell worker.
- Keep deterministic mock execution only where it is a test/local fixture tool.
- Do not edit `legacy/` except for reading it as historical reference.

## Completion Gates

- [ ] `@acpus/agent-executor` executes named acpx agents through the bundled
  acpx CLI.
- [ ] `agent.command` executes through acpx `--agent <command>`.
- [ ] No public API requires or accepts an external acpx path or provider
  command mapping.
- [ ] Absent policy defaults to full permissions and passes explicit acpx flags.
- [ ] `policy: "read"` passes the read-only acpx permission flags and never
  mixes full/read flags in one invocation.
- [ ] Runtime renders and validates non-empty explicit session keys, encodes
  them without collisions, and derives deterministic session names when absent.
- [ ] One scheduler-visible agent attempt performs one acpx turn.
- [ ] Output parse and schema failures commit failed attempts with stable
  `failureKind` values and requeue automatically while conformance retry policy
  allows.
- [ ] A schema-backed agent defaults to initial attempt plus two conformance
  retries unless explicit retry config overrides it.
- [ ] Task schema mismatch does not gain automatic retry unless explicit task
  retry config allows it.
- [ ] Config failures are not retried.
- [ ] Pause/cancel sends cooperative acpx cancel and persists partial
  prompt/response/telemetry artifacts when available.
- [ ] Agent prompt, response, stderr, telemetry, and optional raw ACP debug
  artifacts are stored under run-local attempt paths and registered in SQLite.
- [ ] Public read APIs expose dynamic attempt failure kind and enough metadata
  for CLI/follow to show agent conformance retries.
- [ ] Specs are updated only when implementation behavior matches the new
  current product truth.

## Verification Plan

Use hermetic fake acpx scripts/processes. Tests must not call real networked
agents.

Agent executor tests:

- public API contract and type tests for acpx request/result shapes
- named agent argument construction
- custom `--agent` argument construction
- bundled acpx resolution through package dependency
- sessions ensure failure classification
- prompt execution and raw ACP JSON response extraction
- cooperative cancel on abort
- timeout classification
- output overflow classification
- policy flag mapping and default full policy
- model/cwd/env propagation
- JSON recovery from prose/code fences and conservative repair

Runtime unit/integration tests:

- prompt rendering with output schema section
- explicit and derived session names
- blank session key config failure before acpx dispatch
- runtime-owned environment scrub/overwrite
- agent parse failure -> failed attempt -> scheduler retry
- agent schema failure -> failed attempt -> scheduler retry
- conformance retry uses the same session name
- exhausted conformance retry fails the node
- task schema mismatch does not auto retry by default
- explicit retry/on failure-kind matching
- pause/cancel records partial artifacts and cancels acpx cooperatively
- fork/replay ignore telemetry as scheduler semantics but verify registered
  artifacts through existing artifact registry checks

CLI/read tests:

- `getRun` exposes failure kind and attempt metadata for agent retries
- follow/show output distinguishes retrying conformance failures from terminal
  node failure
- artifact references or metadata pointers are visible enough for inspection

## Non-Goals

- No public scheduler package or public scheduler subpath.
- No direct provider-specific agent SDKs in Acpus.
- No raw shell worker compatibility mode for `agent.command`.
- No external acpx path override as public runtime configuration.
- No broad arbitrary `AgentDefinitionIR.options` mapping in this goal. Model,
  policy, cwd, env, session, timeout, and custom `--agent` command are the
  supported execution controls for this pass.
- No legacy YAML workflow compatibility shims.
- No changes to `legacy/`.

## Risks And Constraints

- `acpx` is alpha, so the implementation should pin a compatible version and
  isolate CLI grammar assumptions inside `@acpus/agent-executor`.
- The executor package should remain deep: acpx process/stream/cancel details
  belong inside the package, while workflow scope, schema validation, retry
  policy, and artifact persistence remain runtime responsibilities.
- Retry metadata must be semantic and stable. Avoid storing free-form error text
  as the only retry decision input.
- Agent telemetry can be large or noisy. Keep read projections compact, write
  full human-readable material to artifacts, and bound live telemetry summaries.
- Do not make scheduler reducers depend on artifact or telemetry content.

