# PRD: acpus — Temporal-backed ACP Agent YAML Orchestrator

> Status: Ready for agent
> Source: synthesized from `acpus_draft_design.md` + `acpus-temporal-prototype-handoff.md` and the aligned design consensus (`/mnt/session/plan.md`, 13 locked decisions).
> Stack: TypeScript + Temporal TS SDK. CLI-first.

## Normative References

The entry-form (CLI + DSL) contracts are defined authoritatively in companion spec documents. They supersede the demo specs in `acpus_draft_design.md` wherever they conflict:

- `docs/spec-cli.md` — CLI Interface Contract (subcommands, node-level control mapping, output modes, exit codes, input/context).
- `docs/spec-dsl.md` — DSL Reference (corrected 8-primitive field tables, expression engine, retry model) + 4 rewritten canonical example specs (lint/compile fixture seeds).

---

## Problem Statement

As a developer running multi-agent / long-horizon / high-failure-rate coding workflows, I have no way to declaratively describe "call which agent + run which script + take what output + when to branch / fan out / loop / wait for approval" and have it survive interruption. Today, if my machine sleeps, a worker crashes, or I cancel mid-run, the agent's in-progress work is lost and I must restart from scratch. There is no single durable source of truth for "where am I in the workflow" and "which agent session does this node map to", so resumption, auditing, and debugging are all ad-hoc. Existing local-runtime orchestrators (the prior Acpus) keep recovery state in a local run-directory, which is fragile, machine-bound, and not observable as a service.

## Solution

`acpus` is a single-binary, CLI-first TypeScript tool that uses **Temporal as its durable execution kernel**. The user authors one declarative YAML spec using 8 primitives (`run:agent`, `run:program`, `parallel`, `fanout`, `switch`, `loop`, `approval`, `subworkflow` + `include`). The YAML is compiled and frozen into an immutable AST/IR snapshot; a deterministic Temporal `RunWorkflow` interprets that IR, dispatching agent/program work into Activities. Because Temporal history is the authoritative control source and ACP sessions are addressable by `sessionId`, any run can be **interrupted anywhere and resumed anywhere** — whether the interruption is an operator pause, a worker crash, or a cancel. The user gets node-level control (`pauseNode/resumeNode/cancelNode/retryNode`), human-in-the-loop approval gates, full observability via Temporal Query projection, and deterministic replay for debugging. A real ACP-compatible Mock Agent makes the costly, non-deterministic scenarios (crash mid-stream, flaky retries, cancellation) reproducible in CI.

## User Stories

### Authoring & compilation
1. As a workflow author, I want to declare a workflow in one YAML file with 8 primitives, so that I can express sequential, parallel, fan-out, conditional, looping, approval, and sub-workflow logic without writing code.
2. As a workflow author, I want every step to require a stable `id` with its output at `steps.<id>.output`, so that I can reference upstream results unambiguously.
3. As a workflow author, I want composite nodes (`fanout`/`loop`/`parallel`/`switch`) to require an explicit `output`/`outputFrom` declaration, so that downstream output contracts stay clear and `lint` fails fast when they're missing.
4. As a workflow author, I want `acpus lint` to statically validate schema, expressions, and reference closure, so that I catch errors before spending agent tokens.
5. As a workflow author, I want `${{ ... }}` expressions evaluated by a sandboxed, deterministic engine (CEL via `@marcbachmann/cel-js`) with no I/O, no randomness, and `now()` bound to the workflow clock, so that runs are replay-safe.
6. As a workflow author, I want my YAML compiled into an immutable AST/IR snapshot with a recorded `astVersion` at run start, so that a running run never re-reads mutable YAML on replay/resume.
7. As a workflow author, I want to declare reusable specs via `include` (inlined) and `subworkflow` (separately observable child workflow), so that I can compose and reuse logic.
8. As a workflow author, I want to declare agents once under `agents:` (type, model, cwd, env, tools_allowlist, max_concurrency), so that steps just reference them by name.

### Running & control
9. As a developer, I want `acpus run wf.yaml --input '{...}'` (inline JSON or a path to a `.yaml`/`.yml`/`.json` file) to submit and execute a workflow, so that I can kick off orchestration from the terminal.
10. As a developer, I want dev mode to embed an in-process temporalite with zero external dependencies, so that I can run locally without standing up infrastructure.
11. As a developer, I want prod mode to connect to a Temporal cluster with `--server` and `--task-queue`, so that the same spec runs against shared infrastructure with resident workers.
12. As an operator, I want to pause a specific running node via `pauseNode(key)`, so that I can intervene without killing the whole run.
13. As an operator, I want pausing a running agent node to cancel the in-flight Activity and persist a partial transcript artifact, so that no in-progress work is silently lost.
14. As an operator, I want `resumeNode(key)` to continue in the same ACP session using a fixed runtime continuation prompt, so that the agent picks up where it left off and the final output is attributed to the resumed attempt.
15. As an operator, I want `cancelNode(key)` and `retryNode(key, options)` as first-class controls, so that I can abort or re-run individual nodes.
16. As an operator, I want node-level control to go through Temporal **Updates** with synchronous validation (run exists, astVersion matches, key valid, node controllable, transition legal), so that I get immediate confirmation that my control action was accepted.
17. As a developer, I want a worker crash to be automatically recovered by Temporal re-scheduling plus acpx `loadSession`, so that long agent runs survive machine failures without manual intervention.
18. As a developer, I want each node addressable by a stable `NodeExecutionKey` (runId / astVersion / nodePath / loopRound? / fanoutItemId? / parallelBranchId? / laneId?) based on DSL ids (not array indices), so that control and observation target the exact logical node across loops and fan-out lanes.
19. As a developer, I want `acpus cancel <run_id>` to propagate cancellation to ACP `session/cancel` and capture partial results, so that I can hand off to a human after aborting.
20. As a developer, I want `acpus resume <run_id>` for client reconnection (Temporal auto-resumes the run itself), so that closing my CLI doesn't lose the run.

### Primitives behavior
21. As a workflow author, I want `parallel` to run static branches concurrently and require all to succeed (unless `on_error: continue`), so that I can express required concurrent work.
22. As a workflow author, I want `fanout` to dynamically map over a list with `max_concurrency` and a `join` strategy (`all`/`race`/`quorum`), so that long-tail laggards don't block the whole run (e.g. `join: quorum` continues at N/M).
23. As a workflow author, I want `switch` with `when`/`else` to select exactly one branch via expression, so that conditional logic stays deterministic (agent decisions are expressed as "prior step output + `when` expression", not an agent directly choosing a branch).
24. As a workflow author, I want `loop` with `while`/`until` and `max_iterations`, where each iteration is an isolated scope readable via `loop.iter`, so that I can build self-correcting feedback loops that can't run forever.
25. As a workflow author, I want `approval` as an explicit human gate (external Signal + durable Timer + `on_timeout: fail|escalate|approve|reject`), distinct from operator pause, so that planned human checkpoints are modeled in the workflow itself.
26. As a workflow author, I want `subworkflow` to launch as a child workflow that is independently observable and cancelable, so that a failure in one branch only affects that branch.
27. As a workflow author, I want `run: program` to support `idempotency_key` and `side_effects: read|write|none`, so that retries don't duplicate side effects on non-idempotent commands.

### Agents & ACP
28. As a developer, I want each prompt to map to one Activity that reuses the ACP `sessionId` (re-prompt if the process is alive, `loadSession` if it died), so that agent context is preserved across crashes.
29. As a developer, I want the Activity to heartbeat sessionId/progress/token offset back to Temporal, so that a new worker can resume with the right context after a crash.
30. As a developer, I want per-node task queues (`acpx-worker-<nodeId>`) so that an agent's follow-up prompts route back to the same machine and workspace, so that I avoid cross-machine workspace fetches.
31. As a developer, I want `acpus agents ls/install/test` to manage locally registered ACP agents from the acpx registry, so that I can see and verify available agents.

### Observability
32. As a developer, I want `acpus inspect <run_id> --tail/--tree/--diff` to project run state from Temporal Query + artifact summaries (never from a local run.json), so that observation is service-native and survives loss of local files.
33. As a developer, I want `acpus ls --status running --since 1h` to list runs from Temporal visibility, so that I can find active/completed runs without local bookkeeping.
34. As a developer, I want large objects (transcripts, raw/parsed outputs, command logs, partial state) stored in an artifact store with only `artifact://` refs in workflow state, so that Temporal history doesn't balloon.
35. As a developer, I want structured per-Activity logs, OTel metrics/traces (CLI→Workflow→Activity→acpx→Agent), and a replay bundle export, so that I can debug and audit runs end-to-end.
36. As an SRE, I want SLIs (workflow success rate, step retry ratio, agent p99 latency, approval median wait, history size p95), so that I can monitor system health and pre-empt history bloat.

### Testing & debugging
37. As a test engineer, I want a Mock Agent that is a real ACP stdio subprocess (started by acpx, 100% ACP-compatible), so that swapping `type: mock` is transparent to acpus/acpx and exercises the real loadSession/cancel path.
38. As a test engineer, I want the Mock Agent driven by a YAML script (prompt-rule matching, text/json/tool_calls/error/partial responses, streaming control, `crash_after_chunks`, chaos block, probability), so that I can reproduce crash/timeout/flaky/cancel scenarios deterministically.
39. As a test engineer, I want a `--replay` golden mode for the Mock Agent, so that I can replay an exact prompt/reply timeline as a regression test.
40. As a developer, I want `acpus run --dry-run` (compile to IR, print schedule, no execution) and `acpus replay --history` (feed prior history to the interpreter), so that I can review specs and debug interpreter logic locally.
41. As a CI maintainer, I want `--json`/`--quiet` output modes and well-defined exit codes (0 success, 2 cancel, 10 lint error, 20 runtime fail, 21 deadline, 30 approval timeout, 40 backend unreachable), so that pipelines can assert outcomes.

## Implementation Decisions

- **Five-layer architecture**: L5 CLI → L4 DSL Compiler → L3 Interpreter (Temporal Workflow) → L2 Activities → L1 Runtime (Temporal Server + Worker Pool + acpx subprocess pool). The interpreter follows **workflow-as-data**: the IR is data, `RunWorkflow` is the interpreter — no per-spec codegen.
- **Language/runtime**: TypeScript with the Temporal TypeScript SDK. (The draft's Go hints are void.)
- **CLI surface**: `run / lint / ls / inspect / signal / cancel / resume / replay / worker / agents / mock`. `signal/cancel/inspect` are thin wrappers over node-level Temporal Updates/Queries.
- **Compiler output**: YAML → JSONSchema validate → AST → optimize → **immutable IR (JSON) snapshot** frozen at run start with recorded `astVersion`; inputs and resolved limits are frozen. A started run never re-reads mutable YAML on replay/resume.
- **Expression engine**: `${{ ... }}` syntax backed by `@marcbachmann/cel-js`. Context vars: `inputs.*`, `secrets.*`, `steps.<id>.output.*`, `loop.iter`, `run_id`, deterministic `now()`. Whitelisted functions: `len/startsWith/matches/json.parse/hash.sha256/coalesce`. No external I/O, randomness, or system time. Precompiled at compile time; evaluated inside the deterministic workflow.
- **Node identity**: `NodeExecutionKey = runId / astVersion / nodePath / loopRound? / fanoutItemId? / parallelBranchId? / laneId?`. `nodePath` is based on stable DSL ids, not array positions. `fanoutItemId` prefers an authored item id/path hash, falling back to index only when no stable identity exists. Loop-body nodes must include the loop round. `attemptOrdinal` is not part of logical identity — only of artifact/attempt identity.
- **Control APIs (Updates)**: `pauseNode(key)`, `resumeNode(key)`, `cancelNode(key)`, `retryNode(key, options)` as Temporal Updates with synchronous validation (run exists & astVersion matches; key valid; node controllable; transition legal; cancellation/resume recorded to control state). `getNodeState(key)` plus run summary / node tree are Queries. Signals are reserved for async notifications that don't need an immediate validated result.
- **Pause/resume semantics**: Two distinct mechanisms. (a) Operator-initiated node-level pause: requests Activity cancellation; the Activity captures cancellation, writes a partial transcript artifact, records a cancelled attempt; the node stays paused with resumable session metadata; resume starts a new attempt in the same ACP session using a **fixed runtime continuation prompt**; final output is attributed to the resumed attempt and prior partials are retained for diagnostics. (b) Crash recovery: Temporal re-schedules the Activity (carrying the prior sessionId) and acpx `loadSession` restores context. These are different concerns from `approval`, which is an in-workflow planned human gate.
- **State authority**: **Temporal history is the single authoritative control source.** `~/.acpus/runs/<run_id>/` is only a local artifact-store implementation + log cache, never the recovery truth. `inspect/ls/monitor` project entirely from Temporal Query + artifact summaries.
- **Artifact store**: an interface with a default local-filesystem implementation (future S3/OSS). Large objects (transcripts, raw/parsed outputs, command logs, partial state, cache entries) go to the store; workflow state holds only `artifact://` refs. Nothing large enters Temporal history.
- **Activities**: `AgentSessionActivity` (long-running, heartbeat, cooperative cancel, `loadSession` resume), `ProgramActivity` (short, retry, `idempotency_key` dedupe), `ApprovalSignalChannel` (Signal + durable Timer), `MockAgentActivity` (test injection), `ArtifactStorageActivity`.
- **Worker affinity**: per-node task queue (`acpx-worker-<nodeId>`) recorded in workflow state so all of an agent's prompts route to the same machine. Optional Agent Entity Workflow for audit/throttling in complex multi-agent scenarios.
- **8 primitives**: `run:agent`, `run:program`, `parallel`, `fanout` (`join: all|race|quorum`, `quorum`, `max_concurrency`), `switch` (single branch via `when`/`else`), `loop` (`while|until` + `max_iterations`, `loop.iter` scope), `approval` (`on_timeout: fail|escalate|approve|reject`), `subworkflow` (+ `include`). Top-level `steps:` is an implicit pipeline; the AST normalizes it to an explicit `pipeline` composite to satisfy nodePath identity.
- **Output contract**: executable nodes expose `steps.<id>.output`; composite nodes (`fanout`/`loop`/`parallel`/`switch`) must explicitly declare `output`/`outputFrom`, enforced by `lint`.
- **Mock Agent**: a standalone binary that is a real ACP-compatible stdio server (`initialize`/`session/new`/`session/load`/`session/prompt`/`session/cancel`), driven by a `mock.yaml` script (ordered prompt-rule matching; text/json/tool_calls/error/partial responses; streaming chunk count + interval + `crash_after_chunks`; `chaos` block; `probability`; `--replay` golden mode). Selected via `type: mock` or CLI `--override-agent`.
- **Build order**: full-width primitives first (draft M1–M6): DSL Compiler + lint + IR + dry-run → InterpreterWorkflow with all 8 primitives (program via echo, agent via mock) → AgentSessionActivity + acpx + loadSession → Mock Agent + scenario coverage → full CLI + temporalite embed → observability/security/registry.

## Testing Decisions

A good test asserts **external behavior at the highest meaningful seam**, never implementation internals. Tests should be deterministic and reproducible; non-determinism is confined to Activities and exercised through the Mock Agent rather than real agents. The four approved seams:

1. **CLI seam (E2E, highest)** — drive `acpus run/lint/inspect/signal/cancel` against a YAML spec backed by the Mock Agent; assert exit codes (per the exit-code spec) and final JSON outputs. This covers the full CLI → compiler → workflow → activity → acpx → mock path. This is the primary acceptance seam.
2. **Workflow seam (Temporal TS testsuite + replay test)** — feed a frozen IR into `RunWorkflow`; drive Updates (`pauseNode/resumeNode/cancelNode/retryNode`) and Queries (`getNodeState`, run summary, node tree); assert interpretation correctness for all 8 primitives and **determinism via replay** (history must not depend on mutable YAML, local clock, randomness, or large artifacts).
3. **Mock Agent seam (real ACP stdio subprocess)** — the load-bearing fixture for scenarios real agents can't reproduce: mid-stream crash (`crash_after_chunks`) → verify `loadSession` resume; never-returns → verify timeout + retry; flaky (`probability`) → verify retry/backoff; `session/cancel` → verify partial capture; `--replay` golden timeline regression.
4. **Compiler seam (unit)** — YAML → JSONSchema validate → AST → frozen IR; CEL precompile/eval correctness via `@marcbachmann/cel-js`; `outputFrom` lint enforcement; `NodeExecutionKey` generation from stable ids.

Mandatory scenario coverage (all via Mock Agent): agent mid-crash → loadSession; agent never-returns → timeout+retry; high retry rate → max_attempts+backoff; fanout partial timeout → `join: quorum`; approval timeout → `on_timeout: escalate`; loop converge/diverge → `max_iterations`; mid-run cancel → partial + cleanup; subworkflow branch failure → `on_error: continue`; large payload → artifact offload; replay idempotency.

Prior art: greenfield repo — no existing tests. The Temporal TS testsuite + replay-test pattern is the canonical reference for seam 2; standard subprocess-fixture patterns for seam 3.

## Out of Scope

- Multi-tenancy and permission model (draft appendix leaves this open; the "program execution fully open" premise holds **only** under the trusted single-tenant assumption and must not be described as a multi-tenant security model).
- Cost governance (billing by agent token / duration).
- Cross-machine artifact sharing (the local-fs → S3/OSS migration path is noted but not built in this PRD).
- A real acpx CLI version-compatibility matrix.
- A web UI beyond the Temporal Web UI and `acpus inspect` CLI replica.
- Real-agent smoke tests beyond a minimal set (the prototype runs on mock).

## Further Notes

- **Top risk to validate early** (handoff): real ACP agent runtimes may lack strong cooperative-cancellation primitives. The prior Acpus adapter could observe cancelled turns but did not expose explicit runtime-level cancel control. Before M3, validate real cancel/`loadSession` behavior (a `diagnose`-style spike) since the entire pause/resume value proposition depends on it.
- Avoid carrying local run-directory assumptions from the prior Acpus into the new service runtime — reuse semantic experience and test scenarios, not the local run-directory implementation.
- This repo is currently greenfield (two design docs + an empty `package.json`, no git, no `src/`). The prior Acpus `specs/` and `src/` referenced in the handoff live in a separate repository and are reference-only.
- Recommended next step after this PRD: `to-issues` to split into independently grabbable issues along the M1–M6 milestones.
