# Authoring Optimization Roadmap — Evaluation 2026-07-15

Status: archived 2026-07-15 after AO-001 through AO-005; AO-006 was
intentionally not executed

Evidence cutoff: 2026-07-15

Scope: Acpus workflow authoring guidance, examples, static diagnostics, Signal
authoring, and the authoring evaluation harness

## Outcome

Improve first-check success with a smaller ordinary-authoring route. Prefer
placement, focused examples, and causal diagnostics over new DSL surface. This
dated record holds the decisions; no separate ADR is planned.

## Evidence Baseline

Run `20260715011657039E58C2357589CAB1FF` used ten requirements, three
Agents, three trials, and separate same-session authoring and retrospective
turns. All 90 sessions completed; authored workflows were checked but not run.

Formal metrics come only from authoring Agent trace artifacts and their
`type: "tool"` events. Retrospectives remain qualitative evidence and a
discrepancy audit.

| Trace metric | Baseline |
| --- | ---: |
| `workflow check` calls | 233 |
| Mean checks per session | 2.5889 |
| First-check pass | 40/90 |
| Single-check pass | 29/90 |
| Failed checks | 122 |
| Sessions with at least three checks | 35/90 |
| P95 checks per session | 6 |
| Maximum checks | 15 |

The retrospective self-report claimed 202 checks, mean 2.24, 34 first-pass
sessions, 29 sessions with at least three checks, and maximum 9. That mismatch
is why self-report is not a measurement source.

Pitfall classes below overlap and are session-deduplicated:

| Class | Sessions | Main symptom |
| --- | ---: | --- |
| Expr, `lift`, or helper use | 54 | JavaScript operators over `Expr`, invalid captures, or missing helpers |
| Composite output/state shape | 31 | `NodeRef` returns, branch unions, or loop-state widening |
| Schema contracts | 15 | Schema values, inferred types, and durable shapes are confused |
| Example discovery/routing | 12 | Examples are opened before the authoring rules are understood |
| Task/artifact authoring | 10 | Inline/reusable choice, capture, inference, or artifact semantics |
| Signal contracts | 9 | Timeout, payload, or concurrent-wait behavior is uncertain |
| Duplicate skill paths | 9 | An Agent reads both copied skill trees |
| Generic/cascading diagnostics | 9 | Root errors are obscured by dependent diagnostics |

## Context Budget

The hard default-route budget is the UTF-8 byte sum of `SKILL.md` and
`references/authoring.md`. Words are recorded for review, but do not replace the
dependency-free byte gate. Optional routes are measured separately.

| Route | Current bytes | Current words | Gate |
| --- | ---: | ---: | --- |
| Default | 10,692 | 1,412 | at most 12,367 bytes (baseline 1,641 words) |
| `advanced-authoring.md` increment | 5,284 | 685 | report only |
| `signal-authoring.md` increment | 1,768 | 246 | report only |

## ROI Queue

| Order | Slice | Cost | Exit signal |
| ---: | --- | --- | --- |
| 0 | AO-001 — Evaluation and measurement hygiene | XS | isolated routes, equal digests, trace-derived metrics |
| 1 | AO-002 — Context-neutral authoring guardrails | S | frequent decisions are visible within the byte budget |
| 2 | AO-003 — Root-cause-first diagnostics | M | causal hints without general TS rewriting |
| 3 | AO-004 — Focused checked examples | S | one small example per missing pattern |
| 4 | AO-005 — Signal contract and duration | S | current semantics are explicit; `d` is supported |
| 5 | AO-006 — Fixed-protocol comparison | M | run only on explicit request and report directionally |

## AO-001 — Evaluation and Measurement Hygiene

- The harness moves out of the bundled skill to
  [`eval/acpus-authoring-evaluation`](../../../eval/acpus-authoring-evaluation/README.md),
  with no compatibility copy.
- Every fresh workspace contains only `AGENTS.md`, `CLAUDE.md`, and the two
  skill copies. Both instruction files route Claude to `.claude` and Pi/TraeX
  to `.agents`; source and copy digests are compared and recorded.
- The protocol remains 10 requirements × 3 Agents × 3 trials. Authoring and
  retrospective stay in separate turns sharing one `sessionKey`.
- The dataset records skill version/digest, selected skill path, Agent config,
  requirement/trial identity, workspace seed, and default/optional route sizes.
- The analyzer invokes or reads the `acpus runs artifacts <run-id> --json`
  contract, selects authoring traces only, and streams only tool events.
- Tool fragments are grouped by `toolCallId`. The final shell command is split
  into executable segments; only a segment beginning `acpus workflow check`
  counts. Search/text references do not count.
- Explicit exit code determines outcome; terminal `completed`/`failed` is the
  fallback. Unknown outcome or multiple checks in one tool call invalidates the
  benchmark. Diagnostic codes come from final tool output.
- Outputs are `trace-metrics.json` and `trace-metrics.md`. Thoughts and message
  content are never inspected.

## AO-002 — Authoring Decisions and API Boundaries

- Keep explicit expression imports. A missing-helper enhancement is limited to
  unresolved `lift`; do not add ambient globals or Expr API sugar.
- Default authoring uses a compact intent map: render with `template`/`md`,
  transform with `lift`, control with predicates/composites, dereference
  `NodeRef.output`, and stabilize/narrow state shapes.
- Loop transitions replace the complete state; no partial, shallow, or deep
  merge is introduced. Empty arrays, `null`, and literal unions use an explicit
  state type. Heterogeneous branch outputs remain unions and branch-only fields
  are narrowed inside `lift`.
- Show the compact `Schema` plus `z.infer` pattern. Inline Task is the default;
  reusable Task starts at the second authored call site or when module/third-
  party imports are required. Runtime fanout/loop instances do not count.
- Reusable Task outputs are stabilized with explicit `Promise<Result>` return
  types and typed locals. Do not add a Task generic or `outputSchema`.
- Acpus has no “private Task data” feature. That wording is removed rather than
  documented.
- Example selection stays after the mental model and rules. Examples import
  exactly the helpers they use; no commented helper menu is retained.
- A claimed `md`/template mismatch needs a minimal reproduction before any
  documentation change.

## AO-003 — Causal Diagnostics

- Preserve native TypeScript diagnostics; do not build a general cascade
  suppression layer.
- For an unresolved `lift` with a valid callback layout, add an import hint and
  suppress only its causal TS7006 callback diagnostics. Existing
  AL001/AL002/AL006 behavior otherwise remains.
- A real heterogeneous union gets a `lift`-narrowing hint. If producer output is
  unavailable, the hint points to fixing the producer rather than pretending it
  is a union.
- Literal/null/empty-array loop state gets a targeted widening hint; no new AL
  code is added.
- Compact diagnostic grouping is reconsidered only if a future identical
  protocol finds at least 3/90 sessions needing extra checks because of a
  diagnostic wall. Structured JSON remains complete.

## AO-004 — Progressive Examples and Skill Routes

Add three small checked examples:

- `typed-loop-state`, routed from default authoring;
- `reusable-task-artifact`, routed only from advanced authoring;
- `parallel-approvals`, routed only from the gated Signal guide.

The skill topology remains progressive:

- routine CLI: check/run/inspect/observe, Agent overrides, signal, pause,
  resume, and cancel;
- advanced CLI: catalog/import/viz/WebUI/skill/version plus run artifact
  lookup/deletion and structured automation;
- runtime recovery actions: retry and fork.

## AO-005 — Signal Contract and Runtime Boundary

- `parallel` plus Signal promises concurrent independent waits only. It does not
  promise participant identity, confidentiality, privacy, or sealed commits.
- Schema-backed invalid payload is rejected before mutation and the same wait
  remains open; this is validation, not an Agent repair turn. Schema-less Signal
  accepts a JSON string.
- `parallel(all)` waits for all. Race takes the first successful branch and
  cancels the remaining waits. Signal output remains inspectable and has no
  identity/ACL layer.
- `onTimeout: { message }` customizes a `signal_timeout` failure; it does not
  return fallback output. Pause/resume preserves the remaining timeout budget.
- The shared duration grammar adds `d` and does not add `w`.
- Sealed Signal and timeout fallback output remain deferred until a targeted
  execution benchmark provides evidence and a new dated roadmap scopes them.

## Conditional API Work

- Design a typed `loop<State>` witness only if the next identical protocol still
  has more than 2/90 first-check failures attributable to loop-state typing.
- Do not add partial loop-state merge, automatic `NodeRef` unwrapping, Task
  generics/output schemas, sealed Signal, or timeout fallback in this slice.

## AO-006 — Comparison Benchmark (Deferred)

Optimization does not automatically trigger evaluation. When explicitly
requested, run the full 90 sessions directly—no 3→9 staging—and preserve the
same requirements, Agents, trials, workspace shape, two-turn protocol, and
check-only rule. Record model/tool, CLI, and skill versions so drift is visible.

There are no preset absolute KPI targets. The directional gate is:

| Metric | Baseline | Improvement |
| --- | ---: | ---: |
| First-check pass | 40/90 | greater than 40 |
| Failed checks | 122 | fewer than 122 |
| Mean checks | 2.5889 | less than 2.59 |
| Default-route bytes | cap 12,367 | remain within cap |

Single-check pass, sessions with at least three checks, P95/max, Agent splits,
requirement splits, and pitfall classes are reported without absolute gates. A
regression in one subgroup stays visible rather than being averaged away.

## Completion and Carry-over

This record was archived after AO-001 through AO-005 were implemented. AO-006
was intentionally not run. Any future comparison or triggered conditional API
work starts in a new dated active roadmap rather than reopening this record.

The following observations are preserved as historical, unscheduled leads:
unify `irDigest`; complete structured CLI states; inspect projection filters;
terminal `statusReason`; SQLite locking; provider/Task error surfacing; input
repair; the transform subset; broader loop ergonomics and scoped `step()`
linting; and `number | Expr<number>` fanout quorum. Each needs a new
reproduction, owner, and active record before promotion.
