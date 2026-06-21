# PRD: acpus - Local Durable Harness for AI-First ACP Workflows

> Status: Draft aligned with local-runtime target
> Stack: TypeScript, Temporal as the local durable execution kernel, acpx, ACP
> Product target: local CLI tool for orchestrating local agents and local programs on one host

## Normative References

Current implementation and design truth lives in `specs/`.

- `specs/INDEX.md` - Spec template and index.
- `specs/cli-spec.md` - Local CLI behavior.
- `specs/workflow-spec.md` - YAML Workflow Spec behavior.
- `specs/local-runtime-target-spec.md` - Local single-host runtime boundary.
- `specs/mock-agent-spec.md` - Current Mock Agent protocol behavior.

Historical design notes and earlier distributed-runtime assumptions live under `docs/archive/` and are not current product truth.

## Problem Statement

Agents are already writing and driving long, failure-prone coding workflows — ACP agents, local commands, branching, fan-out, loops, approvals, resumable state — but today that work runs in the open: ad-hoc prompts and throwaway scripts. Close the terminal, let the machine sleep, crash a process, or cancel mid-turn, and the workflow state is gone; the agent has to reconstruct what happened from scratch. What's missing is a durable harness that lets these workflows survive crashes, pauses, and restarts.

Acpus should solve this as a local CLI tool: one machine, local workspace, local agents, local programs, durable local control state, and explicit artifacts. It should not become a distributed job platform.

## Solution

`acpus` is a CLI-first durable harness built for agents to drive. A spec is written in YAML — typically by an agent through the acpus skill — and Acpus compiles it into a frozen IR snapshot; a local durable runtime interprets that IR and dispatches executable work to local Activities. A single steering agent can run the whole loop: author the spec, launch the Run, follow it, and answer the Signal nodes that pause it. Humans can step in at any of those points, but the design doesn't depend on one.

Agent Steps run through `acpx`, which owns ACP session lifecycle, queue ownership, session loading, session resumption, cooperative cancellation, and agent registry resolution. Acpus owns workflow scheduling, node state, retry, timeout, pause, resume, cancel, output validation, and artifact references.

Program Steps run as local subprocesses on the same host. Agent Steps and Program Steps may omit structured output parsing when a node only needs execution effects or artifact capture. Large transcripts, logs, raw outputs, and partial attempts are stored as local artifacts. Workflow state stores compact state and artifact references rather than large payloads.

## Goals

1. Give agents a durable harness for local agent workflows, with YAML specs as the authoring format.
2. Make every Workflow Run reproducible from frozen inputs and frozen IR.
3. Let developers pause, resume, cancel, retry, inspect, and replay local Runs.
4. Preserve ACP agent context across process crashes through acpx session loading/resumption.
5. Capture partial agent transcripts and local program logs as artifacts.
6. Keep the core product single-host and CLI-native.

## Non-Goals

1. Distributed execution across multiple hosts.
2. Remote worker pools, remote task queues, or cross-machine worker affinity.
3. Shared Temporal clusters as a normal operating requirement.
4. Cross-host workspace transfer.
5. Multi-tenant security or hosted service isolation.
6. Cloud artifact stores as a core runtime dependency.
7. Using `acpx flow run` as the Acpus workflow runtime.

## User Stories

### Authoring

1. As a workflow author, I want to declare a workflow in YAML with primitives for agents, programs, parallelism, fan-out, switches, loops, approvals, subworkflows, and includes.
2. As a workflow author, I want every node to have a stable id so downstream references and operator controls target the intended work.
3. As a workflow author, I want `acpus lint` to validate shape, references, expressions, and output contracts before spending agent time.
4. As a workflow author, I want the runtime to execute a frozen IR snapshot so a running Run never changes because a YAML file changed on disk.

### Local Running And Control

5. As a developer, I want `acpus run wf.yaml --input ...` to execute the workflow locally.
6. As a developer, I want `acpus run --dry-run` to compile and project the schedule without executing agents or programs.
7. As an operator, I want `pauseNode`, `resumeNode`, `cancelNode`, and `retryNode` controls for a specific local node.
8. As an operator, I want pausing a running Agent Step to cooperatively cancel the current acpx turn and persist a partial transcript.
9. As an operator, I want resuming an Agent Step to continue through the same acpx-managed ACP session using a fixed runtime continuation prompt.
10. As a developer, I want closing the terminal not to erase durable run state.

### Agents And Programs

11. As a developer, I want Agent Steps to run through acpx so Acpus does not manage raw ACP sessions itself.
12. As a developer, I want stable acpx session names derived from node identity so continuation targets the right agent context.
13. As a developer, I want acpx crash recovery to reload or resume the ACP session when an agent subprocess died.
14. As a developer, I want Program Steps to execute as local subprocesses with optional structured output capture.
15. As a developer, I want local program stdout, stderr, exit code, and structured output to be captured as artifacts and node outputs.

### Observability And Debugging

16. As a developer, I want `acpus inspect <run_id>` to show the current node tree, statuses, outputs, and artifact refs.
17. As a developer, I want `acpus ls` to list local Runs.
18. As a developer, I want `acpus replay` to verify deterministic workflow interpretation from prior history or a replay bundle.
19. As a test engineer, I want a real ACP-compatible Mock Agent so crash, timeout, retry, cancellation, and schema-failure scenarios are deterministic in tests.

## Implementation Decisions

- **Runtime target**: Acpus is a single-host local CLI workflow runner. Normal operation must not require remote workers, remote task queues, cross-host workspace movement, or a shared Temporal cluster.
- **Durable engine**: Acpus may use an embedded or local Temporal-compatible service as its durable execution engine. Temporal is an implementation kernel, not a distributed product promise.
- **Workflow ownership**: Acpus is the Workflow scheduler. It owns IR interpretation, node state, retries, timeouts, pause/resume/cancel/retry controls, output validation, and artifact references.
- **Agent ownership**: acpx is the local ACP session scheduler. It owns ACP session records, queue owners, session loading/resumption, cooperative `session/cancel`, model/session controls, registry resolution, and local adapter subprocess lifecycle.
- **No acpx flows as runtime**: `acpx flow run` is not the Acpus runtime. Acpus may learn from acpx flows, but the Acpus workflow engine remains the YAML-to-IR local durable interpreter.
- **Executable boundaries**: Agent Steps become local Agent Activities that call acpx. Program Steps become local Program Activities that run subprocesses.
- **Output parsing**: Agent `output` and Program `capture` are optional. When omitted, the runtime does not parse structured output for that Node. When present, they are statically validated.
- **Fanout completion**: `join` defines wait strategy (`all`, `race`, or `quorum` for fanout; `all` or `race` for parallel). `fanout.success_criteria.min_success` defines how many successful lanes are required for overall fanout success after the wait strategy completes.
- **Node identity**: Node execution identity is derived from Run id, IR version, stable node path, loop round, fanout item id, and branch/lane identity where needed. Attempt ordinal is attempt metadata, not logical node identity.
- **acpx session naming**: Agent Activities should pass explicit `--cwd` and stable `--session` values to acpx instead of relying on directory-walk auto-resume.
- **Pause/resume semantics**: Operator pause cancels the in-flight local Activity, asks acpx to cooperatively cancel the ACP turn, stores a partial transcript artifact, and marks the node paused. Resume starts a new attempt using the same acpx-managed session and a fixed runtime continuation prompt.
- **Crash recovery semantics**: If the local worker or agent subprocess dies, Acpus re-runs the local Activity and acpx reloads or resumes the saved ACP session when possible.
- **Artifact storage**: The default artifact store is local filesystem storage. Workflow state should store compact values and `artifact://` references rather than large transcripts or command logs.
- **CLI surface**: The core CLI surface is `run`, `lint`, `ls`, `inspect`, `pause`, `resume`, `cancel`, `retry`, `replay`, `agents`, and `mock`.
- **Mock Agent**: The Mock Agent remains a real ACP-compatible stdio server. Runtime tests should exercise it through acpx once the Agent Activity integration exists.

## Testing Decisions

Tests should assert external behavior at the highest meaningful boundary.

1. **CLI seam**: Drive `acpus run`, `lint`, `inspect`, `pause`, `resume`, `cancel`, and `retry` against local YAML specs.
2. **Workflow seam**: Feed frozen IR into the local durable interpreter; verify node state, deterministic replay, control transitions, and output contracts.
3. **Agent seam**: Run Agent Steps through acpx against the Mock Agent; verify session creation, session loading/resumption, queue behavior, cancellation, partial transcript capture, and schema retry.
4. **Program seam**: Run local subprocess fixtures; verify stdout, stderr, exit code, timeout, optional structured capture, and artifact capture.
5. **Compiler seam**: Validate YAML parsing, reference linting, expression compilation, frozen IR output, and schedule projection.

Mandatory runtime scenarios:

1. Agent mid-turn cancel creates a partial transcript and a paused node.
2. Agent resume continues in the same acpx-managed session.
3. Dead agent subprocess is reloaded or resumed by acpx.
4. Program timeout is recorded as a local node failure.
5. Fan-out respects local `max_concurrency`.
6. Loop respects `max_iterations`.
7. Approval timeout follows the configured local outcome.
8. Large transcripts and command logs are stored as artifacts.
9. Replay does not depend on mutable YAML, system time, random values, or large artifact payloads.

## Open Risks

1. Real ACP adapters may differ in how reliably they support cooperative cancellation, `session/load`, `session/resume`, model selection, and structured streaming.
2. acpx is still alpha; Acpus should pin and validate compatible acpx versions before relying on a specific CLI or runtime API.
3. Local Temporal-compatible embedding must be simple enough that Acpus still feels like a CLI tool, not infrastructure setup.
4. Long local runs need careful artifact compaction so history and logs remain inspectable without becoming too large.

## Milestones

1. Compiler, lint, frozen IR, and dry-run schedule projection.
2. Local durable interpreter for all workflow primitives using mock program and mock agent execution.
3. Program Activity for local subprocess execution and artifact capture.
4. Agent Activity through acpx with Mock Agent coverage for load/resume/cancel.
5. Node-level local controls: pause, resume, cancel, retry, inspect, replay.
6. Real-agent compatibility matrix for the acpx versions and ACP adapters Acpus supports.
