# Runtime orchestrator refactor decisions

Date: 2026-05-30

Status: active decision record

Context:

- This document records the post-validation refactor decisions from the schema-aware output repair discussion.
- It supersedes the previous execution assumption that generated ACPX flow files are directly runnable derived artifacts.
- It should be updated after each coherent batch of design decisions so implementation agents do not lose context.

Related documents:

- `docs/schema-aware-output-repair.md`
- `docs/output-contract-hardening-implementation.md`
- `docs/acpx-workflow-capability-optimization.md`
- `docs/dynamic-workflow-design.md`

## Core Direction

The orchestrator runtime will become the authoritative workflow driver.

ACPX flow execution is removed from the main path:

- Do not use `acpx flow run` to execute workflow stages.
- Do not generate full workflow `.flow.ts` files.
- Do not keep ACPX flow wrappers for debug or compatibility.
- Do not preserve the old goal that `workflow.flow.ts` is directly runnable by `acpx` with compiled segment input.

The runtime will directly manage ACPX persistent sessions through `acpx/runtime`.

## Why The Previous Flow Constraint Is Removed

Earlier designs required generated flow files to be portable and self-contained. That constraint forced several compromises:

- generated flow helpers could not safely import arbitrary npm dependencies;
- output validators were handwritten instead of using richer runtime schemas;
- deterministic JSON syntax repair with packages such as `jsonrepair` was deferred;
- repair prompts could not use a full schema/helper toolchain;
- output parsing, repair routing, and blocked accounting were hidden inside ACPX flow internals;
- repair calls were difficult to count accurately in the logical run index;
- session semantics were coupled to ACPX flow run state;
- generated TypeScript source-string tests became the main compiler contract.

This is no longer the target. The generated flow portability constraint is intentionally dropped.

## Runtime Dependency Baseline

The package may depend directly on ACPX runtime APIs.

Decision:

- Raise `acpx-workflow-orchestrator` runtime requirement from Node 20 to `>=22.13.0`.
- Add `acpx` as a package dependency.
- Use `AcpxRuntime`, `createFileSessionStore`, and related runtime APIs instead of shelling out to `acpx flow run`.

Reasoning:

- `acpx@0.10.0` requires Node `>=22.13.0`.
- Library integration gives stronger session, event, cancellation, permission, and error semantics than CLI subprocess parsing.
- The refactor is intentionally not backward-compatible with the old flow execution model.

## Execution Model

Old model:

```text
spec -> compileWorkflow() -> workflow.flow.ts/materialized.flow.ts -> acpx flow run -> sync projected outputs
```

New model:

```text
spec -> compileExecutionPlan() -> runtime scheduler -> AcpxRuntime session turns -> parse/repair -> run index -> next ready stage
```

The execution plan replaces generated TypeScript flow source as the compile artifact.

The runtime scheduler is step-driven:

- `run` prepares the logical run and starts/advances the first ready work.
- `run --wait` loops scheduler advancement until the logical run reaches a terminal state.
- `syncRun` advances an existing run by observing current state and launching/completing ready steps.
- `follow` and live HTML report use the same run index/state model and do not create new workflows.

The scheduler should be recoverable after process interruption. Run state must be authoritative on disk.

## Compile Artifact

Keep a compile phase, but change its product.

Decision:

- Replace `CompiledWorkflow.flowSource` with an execution plan JSON snapshot.
- Replace `compileWorkflow` semantics with `compileExecutionPlan`.
- Remove `compileFanoutBatchSegment` and flow-source materialization.
- Remove `workflow.flow.ts`, `materialized.flow.ts`, and flow source string tests from the main path.

Execution plan contents should include:

- author stage DAG;
- expanded runtime stage information when needed;
- stage contract names and contract options;
- prompt contexts and variable bindings;
- role/session key plan;
- fanout split/batch plan;
- limits and concurrency policy;
- repair policy;
- final summarizer requirements;
- runtime-only diagnostic/recovery stage policy.

The saved workflow spec remains the stable authoring interface. The execution plan is a runtime-derived snapshot.

## Session Store And Binding

Each logical run gets an isolated ACPX session store.

Directory shape:

```text
.acpx-workflow-orchestrator/runs/<runId>/
  run.json
  workflow.spec.json
  execution-plan.json
  input.json
  acpx-state/
    sessions/
      <encoded acpxRecordId>.json
  sessions/
    role-bindings.json
  prompts/
  outputs/
  attempts/
  events.ndjson
```

Decision:

- Use `createFileSessionStore({ stateDir: <runDir>/acpx-state })`.
- Persist role/session bindings inside the run snapshot.
- Do not use global `~/.acpx/sessions` as the orchestrator workflow session store.

Reasoning:

- Logical runs are auditable and isolated.
- Resume uses the original run snapshot, not ambient global ACPX state.
- Saved run directories can be inspected or archived without scanning global session state.

## Session Key Policy

Session key rules:

- Linear stage default: `role:<roleName>`.
- Repair turn: same session key as the original stage role.
- Fanout item: always a distinct session key, for example `role:<roleName>:fanout:<stageId>:item:<stableItemId>`.
- Reduce/reconcile: use its declared role's normal linear session key unless the spec/runtime defines a more specific role.

Concurrency rules:

- Different session keys may run concurrently.
- The same session key is always serialized by the orchestrator runtime.
- Global `maxConcurrency` controls simultaneously running agent turns across the logical run.
- `maxAgents` remains a hard cap on launched agent turns; repair turns count toward actual usage.

Fanout decision:

- Fanout must use multiple independent sessions.
- This applies to read-only and edit fanout.
- Edit fanout remains high risk and controlled by existing fanout policies and preview warnings.

## Repair Strategy

Repair remains a single contract-repair turn.

Decision:

- Repair uses the same role/session as the failed stage attempt.
- Repair turn is temporarily constrained to read-only/contract-conversion behavior.
- Repair prompt must explicitly forbid redoing task work or editing files.
- Repair is separately counted and audited.
- Repair failure becomes `OUTPUT_REPAIR_FAILED` and is not retried.

Reasoning:

- The original role session has the most context about what work was actually performed.
- Isolated repair would be cleaner but would lose context and rely only on candidate payloads.
- Runtime-owned repair allows accurate `repairCalls`, events, attempts, and diagnostics.

Required repair metadata:

- `repairAttempts: 1`;
- `repairedFromStageAttempt`;
- `originalBlockedReason`;
- parser metadata for the repaired output;
- repair events in `events.ndjson`.

## Attempt Persistence

Attempt-level persistence is required.

Final outputs remain compact and stage-oriented:

```text
outputs/
  <stageId>.json
  <fanoutStageId>/<itemId>.json
```

Attempts hold raw and diagnostic detail:

```text
attempts/
  <stageId>/
    attempt-1/
      prompt.md
      raw.txt
      parse.json
      output.json
    repair-1/
      prompt.md
      raw.txt
      parse.json
      output.json
```

Fanout item attempts:

```text
attempts/
  <fanoutStageId>/
    item-<stableItemId>/
      attempt-1/
      repair-1/
```

Rules:

- `outputs/*.json` is the final author-stage result consumed by downstream stages.
- `attempts/**` is the audit source for raw agent output, parse diagnostics, and repair evidence.
- Blocked stage final output may contain a compact blocked envelope; detailed diagnostics live in attempts.
- RunView and reports default to final outputs but can expand attempts in detail views.

## Status Model

Use separate status enums for attempts, stages, and runs.

```ts
type AttemptStatus =
  | "pending"
  | "running"
  | "raw_received"
  | "parsing"
  | "repairing"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";

type StageStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "diagnosed_blocked"
  | "failed"
  | "cancelled";
```

Mapping rules:

- Attempt `completed`: raw output was received, parsed, normalized, and Zod-valid.
- Attempt `blocked`: agent completed but output contract remained invalid after the allowed repair policy.
- Attempt `failed`: runtime, ACPX, process, or API failure that is not an output-contract blocked result.
- Stage `completed`: final author-stage output exists and is accepted.
- Stage `blocked`: final stage output is blocked, or fanout policy cannot accept blocked items.
- Run `completed`: summarize stage completed and final verdict maps to acceptable success.
- Run `blocked`: human decision, semantic blocked state, or output contract failure that is not runtime-unrecoverable.
- Run `failed`: compiler/runtime unrecoverable errors only.

`OUTPUT_REPAIR_FAILED` maps to blocked attempt/stage/run state, not failed,
unless the runtime itself crashes or cannot recover.

## Report And Live View Attempt Detail

RunView and report projections expose attempt summaries by default.

Default embedded attempt summary:

- attempt id;
- kind: `attempt` or `repair`;
- status;
- started/ended/duration fields when available;
- blocked reason;
- parse summary;
- candidate count;
- first bounded set of schema errors;
- raw preview, for example 2 KiB;
- prompt preview, for example 2 KiB;
- artifact paths for full prompt/raw/parse/output files.

Full attempt artifacts stay on disk:

```text
attempts/.../prompt.md
attempts/.../raw.txt
attempts/.../parse.json
attempts/.../output.json
```

Live report server may expose read-only endpoints to fetch full attempt
artifacts on demand, for example:

```text
GET /api/attempt?path=...&kind=raw|prompt|parse|output
```

The server must constrain requested paths to the active run directory.

Single-file HTML snapshot behavior:

- remains self-contained;
- embeds only bounded attempt summaries/previews;
- does not embed full raw output or full prompts;
- shows run-dir relative paths for full artifacts.

Reasoning:

- Full audit data remains local in the run directory.
- Snapshot HTML stays small enough to review and share.
- Live mode can fetch detail lazily without bloating the base projection.

## Output Contracts

All output contracts move to Zod as the source of truth.

Contracts to cover in this refactor:

- `base`;
- `implementation`;
- `validation`;
- `decision`;
- `discover`;
- `summarize`;
- `diagnostic`.

Do not keep handwritten validators as the main path.

Suggested module shape:

```text
src/contracts/
  output-contracts.ts
  descriptors.ts
  schemas.ts
  examples.ts
  repair-hints.ts
```

Required API shape:

```ts
getOutputContract({
  name,
  options
}): {
  schema: ZodType;
  schemaForPrompt: unknown;
  minimalExample: unknown;
  aliases: AliasHint[];
  describeIssue(issue): FixHint;
}
```

Responsibilities:

- Zod schema performs hard validation.
- Contract descriptors generate prompt footer text.
- Contract descriptors generate schema-aware repair prompts.
- Contract descriptors provide minimal valid examples.
- Alias normalization is deterministic and separate from validation.

## Candidate Parsing And Repair Prompt Direction

The hardened parser remains conceptually valid, but it moves into runtime code and can use package dependencies.

Runtime parser should support:

- exact `workflow-output` fence;
- `json` fence;
- `jsonc` fence;
- malformed `json workflow-output` fence;
- untagged JSON-looking fence;
- trailing raw JSON;
- deterministic syntax repair through a package such as `jsonrepair`;
- wrapper normalization for `{ "workflow-output": { ... } }`;
- Zod validation against the selected contract;
- ambiguity fail-closed.

Syntax repair policy:

- Try `JSON.parse(raw)` first.
- If direct parse fails, run `jsonrepair(raw)` once and then `JSON.parse(repaired)`.
- Mark candidates accepted through this path as `syntax: "repairedJson"`.
- Set `metadata.outputParse.repaired = true` for outputs selected from repaired syntax.
- Syntax repair never adds semantic fields.
- Repaired candidates must still pass deterministic alias normalization and Zod validation.
- Diagnostics must record original parse error, repaired flag, repaired snippet hash, and repair warning.
- Candidate size limits apply before syntax repair.
- If syntax repair creates multiple valid but different candidates, ambiguity still fails closed.

`jsonc-parser` is not part of the v1 main path. It can be considered later for
source-location diagnostics if needed.

Repair prompt must include:

- canonical schema block from the Zod contract descriptor;
- minimal valid example;
- best candidate JSON or bounded best-candidate body;
- direct fix instructions derived from Zod issues;
- alias hints, including narrowly scoped `checks[].result -> checks[].status`;
- strict instruction to emit exactly one `workflow-output` fenced block.

## Deterministic Alias Normalization

v1 only supports one deterministic alias normalization:

```text
checks[].result -> checks[].status
```

Rules:

- Apply before Zod validation.
- Apply only inside `checks[]` entries.
- Apply only when `status` is missing.
- Apply only when `result` is one of `pass`, `fail`, `skipped`, or `unknown`.
- Remove `result` from the normalized output after converting it to `status`.
- Record metadata such as:

```json
{
  "outputNormalizedAliases": ["checks[].result->checks[].status"]
}
```

Do not add broad semantic aliases in v1.

Explicitly rejected v1 aliases:

- `overall_result: "PASS" -> status: "completed"`;
- `errors: 0 -> checks[].status: "pass"`;
- `verdict -> status`;
- `files_modified -> changedFiles`.

Reasoning:

- The observed repair failure was a narrow nested field alias.
- This normalization is safe and mechanical.
- Broader aliases risk silently converting domain reports into workflow outputs, violating fail-closed behavior.

## Explicit Non-Goals After This Decision

- No ACPX flow execution in the orchestrator main path.
- No `workflow.flow.ts` or `materialized.flow.ts` main-path artifacts.
- No direct `acpx flow run` integration.
- No debug/compat ACPX flow wrapper.
- No target-repo flow dependency resolution assumptions.
- No handwritten output validator as the main contract source.
- No forward compatibility logic for the old flow compiler/runtime.
- No throwing compatibility stubs for old flow APIs.

## Compatibility Policy

This refactor is intentionally not forward-compatible with the old
implementation.

Delete old flow APIs and artifacts directly:

- remove or fully rewrite `src/compiler/compile.ts` flow source generation;
- remove `compileFanoutBatchSegment`;
- remove `CompiledWorkflow.flowSource`;
- remove `src/acpx/run-flow.ts` from the main path;
- remove `workflow.flow.ts` and `materialized.flow.ts` run artifacts;
- replace source-string compiler tests with execution-plan tests;
- update docs that mention direct ACPX flow execution or self-contained flow snapshots.

Keep only the conceptual compile phase, renamed/reframed around
`execution-plan.json`.

## Open Questions

The following decisions still need confirmation before implementation:

- None in this batch.
