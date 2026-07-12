# Acpus Agent Authoring Ergonomics Batch Roadmap

Status: active planning
Evidence cutoff: 2026-07-12
Scope: TypeScript workflow authoring, static checking, skill guidance, and local Task capabilities

## Purpose

This roadmap turns the pitfalls reported by two complete Acpus agent-authoring
benchmarks into small, ordered optimization batches. Each batch has one primary
module seam, a bounded issue set, deterministic acceptance checks, and a place
to record benchmark evidence after implementation.

The roadmap tracks future work only. When a batch changes current behavior, the
same change updates the relevant file under `specs/`. Completed batch records
move to `docs/roadmap/archive/` after their implementation and verification are
finished.

## Evidence Baseline

The two benchmark runs each asked Pi, Claude, and TraeX to author ten realistic
workflows in isolated directories:

- Run `20260712023017BB6D49D9347E16B4F260`: 41 self-reported pitfalls.
- Run `20260712132957210F054914E4783D6134`: 25 self-reported pitfalls.
- Combined: 60 authoring executions and 66 pitfalls.

The second run reduced the total by 39%, but it did not remove the two most
consequential classes: agents could still inspect declarations from the wrong
installation, and a workflow check could still accept an operationally unsafe
`maxConcurrency` value.

Self-reported counts measure encountered-and-repaired friction, not agent
quality. Deterministic compiler/runtime tests remain the release oracle;
benchmark pitfall counts are directional product evidence.

## Priority Model

| Priority | Meaning | Release posture |
| --- | --- | --- |
| P0 | Can make an agent follow the wrong product interface, or can pass check and produce incorrect/non-progressing runtime behavior. | Resolve before authoring-surface polish. Run the full 30-case benchmark after the P0 milestone. |
| P1 | Repeatedly causes failed checks, repair loops, unsafe casts, or confusing graph structure, but is normally caught before execution. | Resolve by authoring module and verify deterministically. |
| P2 | Lower-frequency capability, ecosystem, or documentation friction with a clear workaround. | Resolve after P0/P1 interfaces stabilize. |

Within one priority, frequency determines order unless a dependency requires a
different sequence.

## Functional Modules

The roadmap uses module seams rather than assigning the same problem to every
package it happens to touch.

| Module | Interface owned by the module | Primary locations | Batches |
| --- | --- | --- | --- |
| M1 — Authoring installation authority | One trustworthy answer for the running CLI version, package root, skill version, declaration roots, and example roots. | `packages/cli`, `packages/cli/skills/acpus` | B01, B08 |
| M2 — Resolvable resource controls | Author-facing optional limits and their compile/runtime validation, including omitted and zero values. | `packages/core`, `packages/workflow-compiler`, `packages/runtime` | B02 |
| M3 — Graph authoring interface | Composite outputs, callback results, Expr operations, stable ids, and graph-boundary type preservation. | `packages/core`, `packages/expression`, `packages/workflow-compiler` | B03, B04, B05 |
| M4 — Local Task interface | Inline/reusable Task contracts, command execution, artifacts, and reusable read-only facts. | `packages/core`, `packages/tasks`, `packages/workflow-compiler` | B06, B07 |
| M5 — Authoring feedback loop | Checked examples, benchmark fixtures, pitfall classification, and milestone comparison. | `packages/cli/skills/acpus`, `benchmarks/acpus-agent-authoring-benchmark` | Every batch |

The intended direction is a small interface with more behavior hidden behind
it. New public helpers are considered only when they remove knowledge from
multiple callers; diagnostics and implementation-local helpers are preferred
over adding shallow aliases.

## Issue Ledger

Each benchmark pitfall belongs to exactly one issue below, so the frequency
column totals 66.

| Issue | Priority | Pitfall class | Frequency | Module | Batch | State |
| --- | --- | --- | ---: | --- | --- | --- |
| AE-001 | P0 | Skill, examples, declarations, and executed CLI disagree about the current authoring interface. | 6 | M1 | B01 | implemented; final benchmark pending |
| AE-002 | P0 | Optional `maxConcurrency` becomes `Expr<number \| undefined>`; unsafe coercions such as zero can pass check. | 5 | M2 | B02 | queued |
| AE-003 | P1 | Composite output nesting and plain-object callback return rules are hard to predict. | 12 | M3 | B03 | queued |
| AE-004 | P1 | Authors use JavaScript operators/control flow over `Expr<T>`, including inside templates and loops. | 9 | M3 | B04 | queued |
| AE-005 | P1 | Task/fanout/branch output types widen to `any`, `unknown`, or unusable unions. | 8 | M3 | B05 | queued |
| AE-006 | P1 | Inline Task input, output inference, and self-containment rules are not evident from the interface. | 6 | M4 | B06 | queued |
| AE-007 | P1 | Node and Task ids are generated dynamically instead of using stable literals. | 4 | M3 | B04 | queued |
| AE-008 | P1 | `lift` captures outer bindings or durable values use `undefined` instead of JSON-compatible absence. | 4 | M3 | B04 | queued |
| AE-009 | P2 | NodeNext and Zod 4 details cause avoidable authoring failures or cascading diagnostics. | 4 | M1/M5 | B08 | queued |
| AE-010 | P2 | `$` command syntax is misread and no read-only git-facts Task exists. | 3 | M4 | B07 | queued |
| AE-011 | P2 | Artifact option and path/ref semantics are difficult to discover. | 2 | M4 | B07 | queued |
| AE-012 | P2 | Required expression helpers are omitted from imports. | 2 | M5 | B08 | queued |
| AE-013 | P2 | Signal `onTimeout` is mistaken for a default signal output. | 1 | M5 | B08 | queued |

## Batch Sequence

| Order | Batch | Priority | Primary module | Issues | Dependency | Milestone gate |
| ---: | --- | --- | --- | --- | --- | --- |
| 0 | B00 — Baseline and ledger | complete | M5 | all | none | Existing two-run evidence normalized. |
| 1 | B01 — Single authoring authority | P0 | M1 | AE-001 | B00 | Deterministic installation matrix, then continue to B02. |
| 2 | B02 — Safe optional concurrency | P0 | M2 | AE-002 | B00 | Deterministic gate, then continue to B03. |
| 3 | B03 — Composite result ergonomics | P1 | M3 | AE-003 | B01 | Deterministic composite fixtures. |
| 4 | B04 — Expr, lift, and stable-id diagnostics | P1 | M3 | AE-004, AE-007, AE-008 | B03 | Deterministic loop/template/worktree fixtures. |
| 5 | B05 — Type preservation across graph seams | P1 | M3 | AE-005 | B03 | Deterministic fanout/branch/Task fixtures. |
| 6 | B06 — Deep inline Task interface | P1 | M4 | AE-006 | B01, B05 | Full deterministic workspace gate. |
| 7 | B07 — Local Task capability cleanup | P2 | M4 | AE-010, AE-011 | B06 | Deterministic release/artifact/worktree fixtures. |
| 8 | B08 — Ecosystem and checked guidance | P2 | M1/M5 | AE-009, AE-012, AE-013 | B01–B07 | One final full 30-case benchmark after all batches. |

Unless a batch discovers a blocking interface dependency, batches are executed
in this order. A batch is not broadened to absorb adjacent cleanup; new findings
are added to the ledger and assigned to a later batch.

## B00 — Baseline and Ledger

State: completed
Priority: setup
Primary module: M5 — Authoring feedback loop

### Recorded outcome

- Preserved the two raw `results.json` files and their authored workflows.
- Classified all 66 pitfalls into the 13 mutually exclusive AE issues above.
- Recorded per-agent check counts, authoring duration, and design scores for the
  second run.
- Established independent `workflow check` and protocol-compliance checks in
  the benchmark harness.

### Remaining baseline gap

The semantic classification currently lives in this roadmap rather than in a
machine-readable benchmark artifact. The final benchmark records issue counts
after all optimization batches; automation is considered only after the
taxonomy has survived at least two optimization batches without churn.

## B01 — Single Authoring Authority

State: implementation complete; final benchmark pending
Priority: P0
Primary module: M1 — Authoring installation authority
Issues: AE-001
Observed frequency: 6

### Problem

The running CLI, repository package, global npm installation, bundled skill,
examples, and declaration lookup can point at different authoring generations.
Agents encountered incompatible `lift`/`transform`, flat/`run` node specs,
loop shapes, Artifact APIs, and callback signatures while following provided
lookup instructions.

### Deep-module direction

Concentrate installation knowledge behind one internal authoring-environment
module. Its interface reports the running CLI entry/version, resolved `acpus`
package root, skill root/version, declaration roots, and example root. The
existing `doctor` command and skill installation/lookup implementation consume
that same result rather than rediscovering paths independently.

Extending `doctor --json` is preferred over adding a second shallow discovery
command unless implementation work proves the doctor interface cannot serve
both humans and agents cleanly.

### Planned work

- Replace global-first Declaration Lookup instructions with running-CLI-resolved
  paths.
- Expose the resolved authoring environment in structured doctor output.
- Make packaged skill/examples and CLI version traceable to one release.
- Add a doctor failure or warning for a skill/declaration root that belongs to a
  different Acpus installation.
- Update `cli-spec.md`, build/toolchain coverage, and skill text in the same
  implementation change.

### Deterministic verification

- Test repository-local CLI, global symlink, pnpm workspace link, and deliberately
  mismatched global-install fixtures.
- Assert that every reported declaration/example path resolves under the package
  used by the running CLI.
- Run `workflow check` over all bundled examples using only reported roots.
- Assert text and JSON doctor output expose the same authority facts.

### Benchmark exit gate

- Do not run a per-batch benchmark. Validate AE-001 in the single full 30-case
  benchmark after all optimization batches are complete.
- Target: zero wrong-installation lookups and zero version-mismatch repairs.

### Completion record

- Started: 2026-07-12
- Implementation completed: 2026-07-12
- Change/PR: TBD
- Specs updated: `cli-spec.md`, `loader-spec.md`, `build-toolchain-spec.md`
- Test commands: `pnpm typecheck`; `pnpm test`; `pnpm test:dead-code`;
  `pnpm test:dependencies`; `pnpm test:dependencies:strict`; `pnpm test:dist`;
  all passed.
- Benchmark: deferred by product decision until every optimization batch is
  complete. Canceled exploratory run
  `20260712172824A1D90DB80FC6576406D1` is not validation evidence.
- Before/final AE-001 count: `6 → pending final benchmark`
- Follow-ups: keep AE-001 open until the final benchmark confirms zero.

## B02 — Safe Optional Concurrency

State: queued
Priority: P0
Primary module: M2 — Resolvable resource controls
Issues: AE-002
Observed frequency: 5

### Problem

An optional input projects as `Expr<number | undefined>`, while
`maxConcurrency` accepts `number | Expr<number> | undefined`. Agents responded
with fixed literals, defaults, casts, and `lift(value, v => v ?? 0)`. The last
form passed check even though zero can make fanout non-progressing or invalid.

### Deep-module direction

Keep optional limit normalization and positive-integer validation behind one
resource-limit lowering path shared by authoring validation and runtime
materialization. Authors should not need to know whether omission lives outside
or inside an Expr union.

The batch begins by recording one product decision in the relevant spec.
Recommended semantics: omission means no authored cap, a positive integer sets
the cap, and zero/negative/non-integer values are rejected before admission.

### Planned work

- Align the public TypeScript type with the chosen omitted-value semantics.
- Validate literal and runtime-resolved limits through the same rule.
- Produce a stable check/input diagnostic for invalid literal/default values.
- Preserve the invariant during runtime evaluation instead of relying only on
  TypeScript types.
- Apply the same internal rule to other positive resource/count fields where
  semantics match; do not add a generic public abstraction for unrelated counts.

### Deterministic verification

- Cover omitted, schema-defaulted, literal, Expr, zero, negative, fractional,
  and invalid runtime input values.
- Prove that accepted fanout limits make progress and enforce the cap.
- Add the previously accepted `?? 0` support-triage workflow as a regression
  fixture.
- Check whether quorum `count` shares the same invariant before reusing the
  implementation.

### Final benchmark acceptance

- In the one final full benchmark, target zero casts, zero fixed-value fallback
  caused by the interface, and zero unsafe zero semantics in support-triage.
- P0 target: AE-001 and AE-002 both zero; no design-score regression; no
  increase in median checks attributable to installation or concurrency.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final benchmark run: TBD
- Before/final AE-002 count: `5 → TBD`
- Follow-ups: TBD

## B03 — Composite Result Ergonomics

State: queued
Priority: P1
Primary module: M3 — Graph authoring interface
Issues: AE-003
Observed frequency: 12

### Problem

Authors repeatedly mispredicted `.output` nesting for parallel, if, switch,
fanout, and nested leaf results. Composite callbacks also reject direct Expr or
NodeRef output returns and require compatible plain-object shapes across
branches.

### Deep-module direction

Treat composite result construction as one module interface owned by graph refs
and builder lowering. Callers should learn one result rule, while node nesting,
dependency registration, and durable lowering remain implementation details.

The first implementation pass is diagnostic- and type-directed. A breaking
flattening or auto-unwrapping change is considered only if the final
benchmark still shows repeated nesting mistakes after the interface explains
itself.

### Planned work

- Inventory the result shape of every composite and nested leaf combination.
- Improve callback return types so direct Expr/NodeRef returns fail at the
  smallest source expression with a concrete plain-object hint.
- Improve missing `.output` diagnostics where TypeScript currently reports only
  a distant property error.
- Make incompatible if/switch branch fields produce one primary diagnostic with
  both branch locations where feasible.
- Reduce examples to one consistent branch-return pattern.

### Deterministic verification

- Type fixtures for parallel→Agent, parallel→Task, if/switch, fanout, race, and
  quorum result access.
- Negative fixtures for direct Expr return, direct NodeRef return, missing
  `.output`, and asymmetric branch objects.
- Exact diagnostic code/path/hint assertions at the lowest stable checker layer.

### Final benchmark acceptance

- In the one final full benchmark, target AE-003 at most 2 across RPS,
  release-gate, support-triage, localized-release-notes, and SLA
  acknowledgement, with no new casts or wrapper Tasks.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final benchmark run: TBD
- Before/final AE-003 count: `12 → TBD`
- Interface decision: preserve / flatten / other — TBD
- Follow-ups: TBD

## B04 — Expr, Lift, and Stable-ID Diagnostics

State: queued
Priority: P1
Primary module: M3 — Graph authoring interface
Issues: AE-004, AE-007, AE-008
Observed frequency: 17

### Problem

Authors use JavaScript conditions, arithmetic, logical operators, and array
properties over Expr values; capture outer bindings in `lift`; use undefined in
durable values; and generate node ids from loop rounds or helper parameters.
Most failures are detected, but repair often takes multiple checks because the
first diagnostic does not identify the authoring replacement.

### Deep-module direction

Keep graph-token legality and diagnostic ownership local to expression and
workflow checking. Prefer a smaller set of precise diagnostics and hints over a
larger expression-helper interface. Add a public helper only when at least two
real authoring cases cannot be expressed clearly with existing predicates and
`lift`.

### Planned work

- Normalize diagnostics for JavaScript control flow/operators inside ordinary
  code, template interpolation, and loop callbacks.
- Point each diagnostic to the smallest offending expression and suggest the
  matching predicate, `lift`, or Task boundary.
- Explain that loop instance paths already encode rounds, so static node ids do
  not need interpolation.
- Distinguish a forbidden outer graph-token capture from JSON-incompatible
  `undefined`; suggest explicit dependencies for the first and `null`/fixed
  fields for the second.
- Add concise DO/DON'T examples generated from checked fixtures.

### Deterministic verification

- Negative fixtures for ternary, `if`, `>`, `+`, `||`, `.length`, dynamic ids,
  outer capture, and undefined loop state.
- Assert one primary diagnostic and a stable actionable hint for each fixture.
- Positive counterparts using predicates, `lift`, static ids, and JSON-compatible
  absence.

### Final benchmark acceptance

- In the one final full benchmark, target no unrepaired AE-004/007/008 failures
  and at least a 70% reduction in check iterations attributed to those issues.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final benchmark run: TBD
- Before/final counts: `AE-004 9 → TBD`, `AE-007 4 → TBD`, `AE-008 4 → TBD`
- Follow-ups: TBD

## B05 — Type Preservation Across Graph Seams

State: queued
Priority: P1
Primary module: M3 — Graph authoring interface
Issues: AE-005
Observed frequency: 8

### Problem

Types widen across inline Task output, fanout output, lift callbacks, branch
unions, empty loop arrays, and static AgentToken helpers. Agents compensate with
explicit annotations, duplicated lanes, or unsafe casts.

### Deep-module direction

Preserve concrete JSON-compatible result shapes through graph refs and
composites. The graph authoring interface is the test surface; callers should
not import internal result witnesses or repeat compiler implementation types.

### Planned work

- Trace each widening point from Task `exec` return through graph ref projection
  and composite output.
- Fix inference at the earliest shared type seam instead of adding downstream
  casts or overloads per node.
- Improve branch union errors where incompatible shapes are intentional author
  mistakes.
- Document the remaining unavoidable annotations, such as empty array element
  types, with checked minimal examples.
- Prevent a root module-resolution error from cascading into misleading
  composite result diagnostics.

### Deterministic verification

- Compile-time assertions for literal unions, arrays, records, optional fields,
  fanout elements, Task results, and AgentToken selection.
- Negative fixtures ensure invalid field access remains rejected without
  degrading valid values to `any`.
- Existing type tests are replaced or deepened at the public graph-ref interface
  rather than layered on internal helper types.

### Final benchmark acceptance

- In the one final full benchmark, target zero `as any` repairs and AE-005 at
  most 2 across support-triage, expense-approval, incident-room, and
  worktree-tournament.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final benchmark run: TBD
- Before/final AE-005 count: `8 → TBD`
- Follow-ups: TBD

## B06 — Deep Inline Task Interface

State: queued
Priority: P1
Primary module: M4 — Local Task interface
Issues: AE-006
Observed frequency: 6

### Problem

Authors add unsupported `outputSchema`, omit the required input record, rename
the Task context destructuring in ways capture analysis cannot understand, or
capture module imports from inline `exec`. The distinction between inline Task
and `task.define` is learned through failed checks rather than through the
interface.

### Deep-module direction

Present one small Task authoring interface that hides callsite metadata and
self-containment analysis. Inline Task remains the self-contained convenience
path; reusable Task remains the imported/dependency-capable path. Diagnostics
explain which path fits the authored code.

### Planned work

- Decide whether no-input inline Tasks infer an empty input or keep explicit
  `input: {}`; choose the smaller interface after checking metadata/lowering
  consequences.
- Make unsupported `outputSchema` and module capture errors identify the valid
  alternative directly.
- Remove accidental sensitivity to harmless context destructuring aliases if it
  is not required by durable task analysis.
- Keep output type inference owned by the Task result rather than introducing a
  redundant schema surface.

### Deterministic verification

- Inline Task fixtures with empty input, bound input, aliased context, built-in
  imports, module captures, and fixed-shape outputs.
- Reusable `task.define` counterparts prove that imports and shared code work at
  the intended seam.
- Exact TB diagnostic and metadata-lowering assertions.

### Final benchmark acceptance

- In the one final full benchmark, target AE-006 zero without adding boilerplate
  helper modules where an inline Task is sufficient.
- P1 target: AE-003 through AE-008 counts reduced by at least 80%, no protocol
  regression, and no mean design-score regression from the baseline.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final benchmark run: TBD
- Before/final AE-006 count: `6 → TBD`
- Follow-ups: TBD

## B07 — Local Task Capability Cleanup

State: queued
Priority: P2
Primary module: M4 — Local Task interface
Issues: AE-010, AE-011
Observed frequency: 5

### Problem

Authors guess zx-style command methods, call `$` with the wrong form, and
reimplement read-only git inspection through inconsistent shell Tasks. Artifact
authors guess option names and confuse durable refs, URIs, and local paths.

### Deep-module direction

Keep command execution and artifact lifecycle behind TaskContext. Add reusable
Tasks only for repeated domain behavior with a stable result, not as one-to-one
wrappers over shell commands. Read-only repository facts have multiple proven
callers and are the strongest candidate for a deeper `acpus/tasks/git` module.

### Planned work

- Make `$` call forms and result fields discoverable from declarations and one
  checked example.
- Design one read-only git-facts Task returning a stable structured result for
  status/log/diff metadata without modifying the repository.
- Consolidate Artifact write/path/ref guidance and diagnostic hints.
- Keep media serialization with platform JSON/string operations rather than
  reintroducing one-method-per-format Artifact helpers.

### Deterministic verification

- Hermetic temporary-git-repository tests for clean, dirty, detached, and empty
  history states.
- TaskContext command tests for cwd, nothrow, stdout/stderr, and exit code.
- Artifact round-trip tests through the public TaskContext interface.

### Final benchmark acceptance

- In the one final full benchmark, target no guessed command methods, no
  Artifact option repairs, and no custom read-only git shell plumbing where the
  new Task fits.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final benchmark run: TBD
- Before/final counts: `AE-010 3 → TBD`, `AE-011 2 → TBD`
- Follow-ups: TBD

## B08 — Ecosystem and Checked Guidance

State: queued
Priority: P2
Primary module: M1/M5 — Authoring authority and feedback loop
Issues: AE-009, AE-012, AE-013
Observed frequency: 7

### Problem

Authors lose checks to NodeNext `.js` extensions, Zod 4 signatures, missing
expression imports, and incorrect Signal timeout assumptions. These have simple
workarounds but should not require declaration archaeology.

### Deep-module direction

Keep ecosystem knowledge in a small set of executable, checked examples tied to
the authoritative installation from B01. Avoid duplicating prose across the
skill and docs; route each concept to one example and one nearby explanation.

### Planned work

- Add or tighten minimal checked examples for relative Task imports, Zod records
  and descriptions, expression helper imports, and Signal timeout behavior.
- Make the first module-resolution diagnostic suppress dependent composite type
  noise where feasible.
- Add a compact DO/DON'T index generated or verified against the same fixtures.
- Review the skill for stale global paths and duplicate API descriptions after
  all preceding batches settle.

### Deterministic verification

- Every code block promoted as an official example has a corresponding checked
  fixture or is generated from one.
- Negative NodeNext, Zod, import, and Signal fixtures assert the first actionable
  diagnostic.
- Skill packaging tests verify the skill version, examples, and declaration
  roots belong to the running CLI installation.

### Final benchmark acceptance

- Run one complete 30-case benchmark after every optimization batch is done.
- Final target: zero AE-001/002; at least 80% reduction in AE-003 through
  AE-008; zero known AE-009 through AE-013 repairs in affected cases; 30/30
  protocol compliance; 30/30 independent checks pass.
- Compare actual durable Agent attempt duration, check counts, final design
  scores, and self-reported pitfalls against both baseline runs.

### Completion record

- Started: TBD
- Completed: TBD
- Change/PR: TBD
- Specs updated: TBD
- Test commands: TBD
- Final full benchmark run: TBD
- Before/final counts: `AE-009 4 → TBD`, `AE-012 2 → TBD`, `AE-013 1 → TBD`
- Follow-ups: TBD

## Gate Applied to Every Batch

Every batch records two kinds of evidence.

### Deterministic gate

- Relevant package typecheck and lowest-layer unit/contract tests.
- Exact positive and negative authoring fixtures for the issue being closed.
- All official Acpus skill examples pass `acpus workflow check`.
- Full workspace typecheck/test before handoff when the batch changes a public
  authoring interface or checked artifact.
- Specs describe only the resulting current behavior when implementation lands.

### Final agent benchmark gate

- Run once after all optimization batches are complete. Use the current
  repository CLI and copy the same repository skill digest into
  both `.agents/skills/acpus` and `.claude/skills/acpus` in every isolated
  workspace.
- Agents author and check workflows but do not run them.
- Record durable Agent attempt duration separately from orchestration-envelope
  time.
- Record actual checks, self-reported pitfalls, harness check, protocol
  compliance, and semantic design score.
- Treat stochastic count changes as evidence, not as a replacement for the
  deterministic gate.

## Batch Update Protocol

When work on a batch begins:

1. Change its state from `queued` to `in progress` and record the start date.
2. Freeze the exact issue IDs and planned spec/test files for that batch.
3. Put newly discovered adjacent work in the issue ledger instead of expanding
   the active batch silently.

When work finishes:

1. Fill every field under the batch's completion record.
2. Record deterministic commands and their results.
3. Record deterministic results; the last batch records the single full
   benchmark run id and all before/final issue counts.
4. Mark issue rows `validated` only after their deterministic gate and the final
   benchmark gate pass.
5. Move the completed batch record to `docs/roadmap/archive/` once its behavior
   is represented in specs and no required follow-up remains.

## Deferred Questions

- Whether composite outputs should eventually flatten nested leaf `.output`
  fields is intentionally deferred to B03 evidence.
- Whether no-input inline Tasks should infer `{}` is intentionally deferred to
  B06 because it affects task metadata and lowering.
- Whether pitfall classification should become a machine-readable benchmark
  artifact is deferred until the taxonomy remains stable through B01 and B02.
- New workflow installation/product-distribution features remain outside this
  roadmap unless they are required to establish the single authoring authority
  in B01.
