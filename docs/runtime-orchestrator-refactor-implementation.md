# Runtime orchestrator refactor implementation plan

Date: 2026-05-30

Status: implementation plan

Source decisions: `docs/runtime-orchestrator-refactor-decisions.md`

Related context:

- `docs/schema-aware-output-repair.md`
- `docs/output-contract-hardening-implementation.md`
- `docs/acpx-workflow-capability-optimization.md`

## Summary

Rebuild `acpx-workflow-orchestrator` so the orchestrator runtime, not ACPX flow, is
the workflow execution authority.

This is a full, intentionally breaking refactor. Implementation should be
allowed to replace the current architecture rather than incrementally adapt it.

Hard compatibility rule:

- Do not preserve old flow APIs.
- Do not preserve old generated flow artifacts.
- Do not add forward-compatibility shims.
- Do not add throwing compatibility stubs.
- Do not keep old code paths merely to reduce diff size.
- Prefer deleting/replacing old modules over wrapping them.
- Tests and docs should assert the new runtime-driven architecture, not the old
  ACPX-flow behavior.

The new execution model:

```text
workflow.spec.json
  -> validate/lint
  -> compileExecutionPlan()
  -> execution-plan.json
  -> step-driven runtime scheduler
  -> AcpxRuntime.ensureSession/startTurn
  -> runtime output parser
  -> Zod contract validation
  -> optional schema-aware repair turn
  -> outputs/attempts/run index
  -> next ready stage
```

## Goals

- Remove ACPX flow execution from the orchestrator main path.
- Use `acpx/runtime` directly for persistent sessions and agent turns.
- Replace generated TypeScript flow snapshots with JSON execution plans.
- Move output parsing, validation, repair, and accounting into orchestrator
  runtime.
- Make Zod schemas the source of truth for every output contract.
- Persist complete attempt-level audit artifacts.
- Preserve runtime recoverability through disk-backed run state.
- Keep report projections compact while retaining full local audit artifacts.

## Non-Goals

- No forward compatibility with old flow compiler/runtime APIs.
- No `workflow.flow.ts` or `materialized.flow.ts` artifacts.
- No `acpx flow run` execution.
- No debug/compat ACPX flow wrapper.
- No target-repo dependency resolution assumptions.
- No handwritten output validators as the main path.
- No semantic output repair beyond explicitly approved deterministic aliases.

## Package And Dependency Changes

Update `skills/acpx-workflow-orchestrator/package.json`:

- `engines.node`: `>=22.13.0`
- add runtime dependency: `acpx`
- add runtime dependency: `jsonrepair`

Keep Zod as the output contract source of truth.

Implementation note:

- `acpx@0.10.0` itself requires Node `>=22.13.0`.
- Use library API imports from `acpx/runtime`.
- Do not shell out to `acpx flow run`.

## Delete Or Replace

Delete or fully replace these main-path concepts:

- `CompiledWorkflow.flowSource`
- `compileFanoutBatchSegment`
- `workflow.flow.ts`
- `segments/*/materialized.flow.ts`
- `src/acpx/run-flow.ts`
- source-string compiler tests that assert generated flow text
- docs that describe direct ACPX flow execution as a supported path

The `compile` concept remains, but the output is `execution-plan.json`.

## New Module Layout

Suggested structure:

```text
src/contracts/
  output-contracts.ts
  schemas.ts
  descriptors.ts
  examples.ts
  repair-hints.ts
  normalize.ts

src/compiler/
  execution-plan.ts
  compile-execution-plan.ts

src/runtime/
  scheduler.ts
  stage-runner.ts
  agent-runtime.ts
  output-parser.ts
  repair.ts
  attempts.ts
  session-bindings.ts
  fanout-runner.ts
  run-workflow.ts
  sync.ts

src/projections/
  run-view.ts
  run-report.ts
```

Existing module names may be reused if cleaner, but old flow-generation behavior
must be removed rather than preserved.

## Execution Plan

Replace `compileWorkflow()` with `compileExecutionPlan()`.

Execution plan file:

```text
.acpx-workflow-orchestrator/runs/<runId>/execution-plan.json
```

Minimum shape:

```ts
type ExecutionPlan = {
  version: "acpx-workflow-orchestrator.execution-plan/v1";
  workflowName: string;
  root: string;
  stages: ExecutionPlanStage[];
  roles: Record<string, ExecutionPlanRole>;
  limits: ExecutionPlanLimits;
  prompts: Record<string, PromptPlan>;
  contracts: Record<string, ContractPlan>;
  repairPolicy: RepairPolicyPlan;
  fanout: FanoutPlan[];
};
```

`ExecutionPlanStage` should include:

- author stage id;
- kind;
- dependencies;
- role name when applicable;
- session key strategy;
- contract name and contract options;
- prompt id/context;
- fanout/reduce/decision/fixLoop-specific runtime metadata;
- stage-level tightened limits.

`compileExecutionPlan()` responsibilities:

- preserve author stage DAG semantics;
- validate single root and terminal summarizer constraints through existing lint;
- precompute prompt variable contexts;
- assign session key strategy;
- attach output contract names/options;
- attach repair policy;
- attach fanout batch constraints;
- produce a stable JSON snapshot for resume.

Do not include executable TypeScript source in the execution plan.

## Run Directory Layout

New run directory:

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
    <stageOrAttempt>.md
  outputs/
    <stageId>.json
    <fanoutStageId>/
      <itemId>.json
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
    <fanoutStageId>/
      item-<stableItemId>/
        attempt-1/
        repair-1/
  events.ndjson
```

Rules:

- `outputs/**` contains only final stage/item outputs consumed by downstream
  stages.
- `attempts/**` contains raw prompt/response/parse evidence.
- `run.json` stores core status and indices, not bulky raw payloads.
- Writes to `run.json` remain atomic and lock-protected.

## Status Model

Use three separate status enums.

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

- Output contract failures map to `blocked`, not `failed`.
- `OUTPUT_REPAIR_FAILED` maps to blocked attempt/stage/run state.
- `failed` is reserved for compiler/runtime/unrecoverable ACPX failures.
- `completed` run requires successful summarize output and acceptable
  `finalVerdict`.

## ACPX Runtime Integration

Use `acpx/runtime`.

Runtime setup per logical run:

```ts
const sessionStore = createFileSessionStore({
  stateDir: path.join(runDir, "acpx-state")
});

const runtime = new AcpxRuntime({
  cwd,
  sessionStore,
  agentRegistry,
  permissionMode,
  nonInteractivePermissions,
  timeoutMs,
  mcpServers,
  authPolicy,
  authCredentials
});
```

Exact constructor options should follow the installed `acpx/runtime` public
contract.

Session binding rules:

- linear role: `role:<roleName>`;
- repair: same session key as failed role attempt;
- fanout item: `role:<roleName>:fanout:<stageId>:item:<stableItemId>`;
- same session key is serialized;
- different session keys may run concurrently within global limits.

Persist role bindings:

```text
sessions/role-bindings.json
```

Each binding should include:

- session key;
- role name;
- agent;
- cwd;
- acpx record id;
- backend session id;
- agent session id;
- last used timestamp.

## Scheduler

Use a step-driven scheduler.

Core operations:

- prepare run;
- identify ready stages/items;
- start agent turns up to global concurrency and session-key constraints;
- collect completed turn results;
- parse and validate raw output;
- run repair when policy allows;
- write final outputs;
- aggregate fanout;
- decide next stage readiness;
- update run status.

CLI behavior:

- `run`: prepare and advance initial work, then return run id unless `--wait`.
- `run --wait`: loop scheduler until terminal.
- `syncRun`: advance an existing logical run.
- `follow`: observe and optionally trigger sync advancement for that run.
- live report server: observes run state and can call the same sync advancement
  path only for the selected run.

Do not create a new workflow from `follow` or live report.

## Agent Turn Lifecycle

For an agent stage attempt:

1. Resolve stage prompt from execution plan variables.
2. Write attempt `prompt.md`.
3. Ensure ACPX session for the stage session key.
4. Start turn with `AcpxRuntime.startTurn()`.
5. Stream events to `events.ndjson`.
6. Capture final raw text to attempt `raw.txt`.
7. Parse and validate output.
8. If valid, write attempt `output.json` and final `outputs/<stageId>.json`.
9. If invalid and repairable, run repair lifecycle.
10. If repair succeeds, write final output from repair.
11. If repair fails, write blocked final output and mark stage/run blocked.

The runtime must increment actual agent usage for every started agent turn,
including repair.

## Output Contracts

All output contracts are Zod-backed.

Contracts:

- `base`
- `implementation`
- `validation`
- `decision`
- `discover`
- `summarize`
- `diagnostic`

Contract API:

```ts
type OutputContract = {
  name: OutputContractName;
  schema: z.ZodType;
  schemaForPrompt: unknown;
  minimalExample: unknown;
  aliases: AliasHint[];
  describeIssue(issue: z.core.$ZodIssue): FixHint;
  footerText(): string;
};
```

Use this contract object for:

- validation;
- prompt footer text;
- repair schema block;
- minimal valid example;
- issue-to-fix hint generation.

Do not maintain a separate handwritten validator as the main path.

## Parser Pipeline

Runtime output parser stages:

1. Enforce max output/candidate limits.
2. Collect candidates:
   - exact `workflow-output` fence;
   - `json` fence;
   - `jsonc` fence;
   - malformed `json workflow-output` fence;
   - untagged JSON-looking fence;
   - trailing raw JSON.
3. For each candidate:
   - `JSON.parse(raw)`;
   - if that fails, `jsonrepair(raw)` once and `JSON.parse(repaired)`;
   - unwrap `{ "workflow-output": { ... } }`;
   - deterministic alias normalization;
   - Zod validation.
4. Select one valid candidate.
5. If multiple different valid candidates exist, return `OUTPUT_AMBIGUOUS`.
6. If JSON candidates exist but fail schema, return `OUTPUT_SCHEMA_FAILED`.
7. If no parseable candidate exists, return `OUTPUT_PARSE_FAILED`.

Candidate metadata should include:

- candidate id;
- mode;
- syntax status;
- wrapper/unwrapped;
- parse error;
- Zod issues;
- alias normalizations;
- raw hash;
- bounded raw/normalized previews;
- best candidate body path or bounded inline body.

## Deterministic Alias Normalization

v1 supports only:

```text
checks[].result -> checks[].status
```

Apply only when:

- object is inside `checks[]`;
- `status` is missing;
- `result` is one of `pass`, `fail`, `skipped`, `unknown`.

Remove `result` from normalized output after conversion.

Do not infer status from domain-specific fields.

## Schema-Aware Repair

Repair policy:

- one repair turn maximum;
- repairable reasons:
  - `OUTPUT_PARSE_FAILED`;
  - `OUTPUT_SCHEMA_FAILED`;
  - `OUTPUT_AMBIGUOUS`;
- repair turn uses same role/session as failed attempt;
- repair turn is read-only/contract-conversion only;
- repair failure becomes `OUTPUT_REPAIR_FAILED`.

Repair prompt must include:

- contract name;
- canonical schema block from contract descriptor;
- minimal valid example;
- selected best candidate JSON or bounded body;
- direct issue-to-fix instructions;
- deterministic alias hints;
- raw snippet only as supporting context, not as the primary payload;
- strict instruction to emit exactly one `workflow-output` fenced block.

Repair prompt must forbid:

- redoing task work;
- editing files;
- inventing command results;
- changing factual content except schema conversion.

## Fanout

Fanout item execution:

- every item gets an independent session key;
- fanout item attempts are persisted under item-specific attempt paths;
- read-only and edit fanout both use independent sessions;
- global concurrency pool controls running turns;
- stage-level limits only tighten global limits.

Partial policy:

- keep existing v1 semantics:
  - `allowPartial` default false;
  - partial only allowed when spec policy permits;
  - edit fanout partial remains high risk and must be previewed.

After edit fanout:

- require read-only reconcile/reduce before downstream summarize or decision,
  preserving prior design decisions.

## Reports

RunView and report projections should read final outputs and attempt summaries.

Default projection includes:

- stage graph;
- final stage outputs;
- attempts summary;
- parse diagnostics summary;
- repair attempt summary;
- paths to full artifacts.

HTML snapshot:

- remains a single self-contained file;
- embeds bounded attempt summaries/previews only;
- does not embed full raw output or full prompts;
- shows relative artifact paths.

Live server:

- may expose read-only API for full attempt artifacts;
- must constrain all requested paths to the run directory;
- observes and advances only the selected logical run.

## CLI Impact

Commands keep user-facing intent but change internals:

- `validate`: spec schema/lint only.
- `preview`: compile execution plan and show risks.
- `run`: prepare run and scheduler.
- `resume`: use execution plan/run snapshot, not flow segments.
- `follow`: follow run index/events and optionally sync.
- `report`: build from run index, outputs, attempts, events.
- `save`: save spec plus helper/package snapshot; do not save runnable flow.

Remove references to:

- `workflow.flow.ts`;
- `materialized.flow.ts`;
- direct `acpx flow run`;
- compiled segment input.

## Testing Strategy

Use Vitest.

### Unit

- Zod contract validation for all contracts.
- Contract descriptor schema blocks and minimal examples.
- Alias normalization only for `checks[].result -> checks[].status`.
- Parser candidate extraction and `jsonrepair` syntax repair.
- Ambiguity fail-closed.
- Repair prompt includes schema, example, best candidate, and fix hints.
- Execution plan compiler output.
- Scheduler readiness and status transitions.
- Session key planning.

### Integration/Fake E2E

Use a fake ACPX runtime adapter or test double for `AcpxRuntime`.

Cover:

- linear workflow completes through summarize;
- schema-invalid output repairs and completes;
- `checks[].result` alias normalizes;
- repair failure becomes blocked with `OUTPUT_REPAIR_FAILED`;
- fanout items use independent session keys;
- global concurrency and same-session serialization;
- attempts are persisted;
- run resume uses run-local session store and execution plan.

### Real E2E

Keep formal real-agent E2E as a separate script, default skipped unless enabled.

Required cases:

- deterministic contract workflow;
- small code task workflow with real `trae` or `aiden`;
- focused rerun of the `67-zhaopin` output-contract scenario when environment is
  available.

Real E2E may skip due to environment, but the suite must remain maintained.

### Validation Commands

Expected final gate:

```sh
npm run typecheck
npm run test:unit
npm run test:e2e:fake
npm run build
npm run validate
```

Update scripts if package structure changes, but keep these high-level gates.

## Implementation Phases

### Phase 1: Package Baseline And Contract Layer

- Raise Node engine.
- Add `acpx` and `jsonrepair`.
- Add Zod output contract modules.
- Replace prompt footer generation with contract descriptors.
- Add parser module using contract descriptors.
- Add unit tests for contracts/parser/repair prompt.

### Phase 2: Execution Plan Compiler

- Replace flow source compiler with execution plan compiler.
- Write `execution-plan.json` during run preparation.
- Update preview to read execution plan.
- Replace compiler tests.
- Remove generated flow artifacts.

### Phase 3: Runtime Session Layer

- Add run-local ACPX session store.
- Add session binding persistence.
- Add `AcpxRuntime` wrapper/test double seam.
- Implement agent turn lifecycle and event capture.
- Persist attempts.

### Phase 4: Scheduler

- Implement step-driven scheduler.
- Implement linear stages, decision gates, reduce, discover, summarize.
- Implement fanout item scheduling with independent sessions.
- Implement fixLoop semantics without ACPX flow.
- Update run/resume/follow/sync commands.

### Phase 5: Repair And Blocked Semantics

- Wire parser failures into repair policy.
- Run repair turns in same role session with read-only/contract-only prompt.
- Persist repair attempts.
- Map `OUTPUT_REPAIR_FAILED` to blocked.
- Fix agent usage and repair call accounting.

### Phase 6: Reports And Docs

- Update RunView/report projections for attempts.
- Update HTML live server for attempt artifact endpoint.
- Update Markdown report.
- Rewrite docs removing ACPX flow execution language.
- Update `SKILL.md` to describe runtime-driven orchestration.

### Phase 7: Full Validation

- Run all validation commands.
- Run fake e2e.
- Run real e2e when environment is available.
- Verify no old flow artifacts remain in generated run directories.

## Acceptance Criteria

- No main-path code invokes `acpx flow run`.
- No run directory writes `workflow.flow.ts` or `materialized.flow.ts`.
- `execution-plan.json` exists for every prepared run.
- Every agent turn goes through run-local `AcpxRuntime` session handling.
- Fanout items use independent session keys.
- Same session key is serialized.
- Output contracts validate through Zod.
- Repair prompt is schema-aware and candidate-aware.
- `checks[].result: "pass"` normalizes to `checks[].status: "pass"`.
- Repair failure is blocked, not failed.
- Attempts persist prompt/raw/parse/output artifacts.
- Reports show attempt summaries without embedding unbounded raw output.
- Old flow compiler APIs are removed, not stubbed.
- Validation commands pass.
