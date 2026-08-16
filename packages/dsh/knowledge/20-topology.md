# Topology and scale knowledge

## Derive the minimum sufficient graph

Before declaring nodes:

1. split the outcome into the fewest bounded duties that can be executed and checked;
2. classify each duty as deterministic Task work or open-ended Agent work;
3. add edges only where a downstream duty consumes upstream data or a control decision;
4. add independent verification only when uncertainty, consequence, or an explicit rubric makes it valuable;
5. add reduction or adjudication only when multiple outputs need compression, reconciliation, or selection.

An additional Agent occurrence earns its place only when removing it would lose required coverage, a distinct hypothesis or implementation, necessary specialist capability, independent evidence, or justified verification. Do not add a planner when duties are already obvious, a synthesizer when one result can be returned directly, a reviewer for low-risk work with no independent check requirement, or a reducer for a small bounded result set.

After deriving the graph, count total Agent occurrences and peak simultaneously ready Agents as a cost audit. Tasks do not count:

| Scale | Agent occurrences | Typical shape |
| --- | ---: | --- |
| Minimal | 0–1 | Deterministic Task-only execution or one coherent Agent duty. |
| Small | 2–4 | A few independent duties, or one worker plus justified verification. |
| Standard | 5–12 | Multi-aspect exploration, alternatives with review, or bounded synthesis. |
| Large | 13–32 | Many independent items or consequential work needing broader redundancy. |
| Extra-large | 33+ | An explicit corpus, search space, or budget; staged reduction is required. |

These ranges describe the graph; they are never targets or defaults. Without an explicit budget, choose the lowest range justified by the duty map. Tell the user before unusually costly or highly concurrent execution when that cost could materially change their choice.

## Select topology from information flow

| Work structure | Best starting topology |
| --- | --- |
| Exact deterministic operation or observation | One `task`. |
| One narrow coherent open-ended duty | One Agent. |
| Fixed independent roles/checks known while authoring | `parallel`. |
| Runtime or planner-produced list of items/lenses | `fanout`. |
| Competing approaches followed by selection | parallel/fanout candidates → independent reviews → judge. |
| Coverage cannot be enumerated reliably while authoring | planner → validate distinct aspects → fanout evidence gathering. |
| Many findings exceed direct synthesis capacity | deterministic batches → fanout reducers → synthesis. |
| Iterative improvement with useful feedback | bounded `loop` with explicit state and stop predicate. |
| Context must persist across rounds | `sessionKey` on the resident worker only. |
| Criticism must remain fresh and independent | reviewer without `sessionKey`. |
| Data-dependent route | `if` or ordered `switch`. |
| Deterministic transform, command, validation, or batching | `task`; use `assert` for invariants. |
| Input/approval must arrive after admission | `signal`, optionally followed by `assert`. |
| First acceptable branch should win and others may be canceled | `parallel` race. |

## Parallel: fixed independent duties

Use `parallel` when the branch set is known at authoring time and branches are independent when they become ready. Give each branch a different role, rubric, hypothesis, evidence source, or verification dimension. Do not serialize independent ready work. Default all-success semantics are right when every branch is required for a trustworthy result.

Use `strategy: "race"` only when any one successful branch fully satisfies the same contract and canceling the rest is acceptable. Race does not mean “pick the best”; it means “first success wins.” To compare quality, run candidates normally and add a judge.

Do not put a dependency inside parallel. If quality review consumes the output of security review, it belongs after the parallel scope rather than beside it.

## Fanout: runtime collections

Use `fanout` when repetition is driven by runtime data: search aspects, files, issues, candidates, experiments, or planner output. Its body should give every item a bounded, non-overlapping duty and enough shared context to be evaluated consistently.

Default fanout preserves input order. Quorum is appropriate only when partial success is genuinely sufficient; specify the acceptance count and ensure final synthesis knows evidence is partial. Use `maxConcurrency` only for an explicit operational cap, not as a substitute for logical scale design.

For research whose coverage cannot be enumerated directly, do not ask a planner to solve the problem. Ask it to produce only the distinct coverage axes justified by the requested breadth, validate their number and shape in a Task, then fan out investigators. Require current primary sources, publication/event dates, provenance, contradictions, and uncertainty in each duty.

## Staged reduction

When a fanout result is too large for reliable direct synthesis, do not feed it directly into one final Agent. Large context destroys evidence locality and makes omissions invisible. Instead:

1. deterministically batch findings with a Task;
2. fan out reducers over batches;
3. require reducers to preserve provenance, disagreement, risks, and open checks;
4. synthesize only the reduced set while retaining links back to source findings.

A reducer compresses evidence; it must not silently invent consensus. A final synthesizer resolves only disagreements it has evidence to resolve.

## Loop: stateful improvement

Use a loop only when later work can consume a concrete delta from earlier work. Good deltas include reviewer feedback, failed tests, an unmet rubric item, or newly collected evidence. Repeating the same prompt is not iteration.

Loop is do-while. The callback receives `{ state, round }`; every transition replaces the complete state. Define a stable state type, semantic stop condition, and hard round bound. Typical pattern:

`resident worker → fresh structured reviewer → replace {result, feedback, accepted} → stop on accepted OR max rounds`

Give the continuing worker a `sessionKey` when its context is useful. Keep reviewers fresh when independence matters. Only the reviewer needs `outputSchema` if deterministic loop control reads `accepted` and `feedback`; the worker result can remain prose.

## If, switch, signal, and assert

Use `if` for one predicate and `switch` for ordered mutually exclusive routes. Build predicates with expression helpers; JavaScript control flow cannot inspect Expr values. Keep branch output shapes uniform when downstream code reads shared fields, otherwise narrow the union in `lift`.

Signal represents an external value arriving after admission. It is not a substitute for asking an ordinary clarification before authoring. Schema-backed Signals validate payloads; invalid input leaves the wait open. Timeout closes the wait as failed—it does not create fallback output.

Assert enforces a deterministic condition. Do not use it for subjective quality; assign that judgment to an Agent and expose a typed boolean only when graph control needs it.

## Candidate, reviewer, judge discipline

- Candidates explore genuinely different approaches; vary assumptions or strategy, not wording.
- Reviewers receive the original task, rubric, and all relevant candidates. Give independent reviewers non-overlapping dimensions such as correctness, evidence quality, operational risk, or user fit.
- A candidate must not judge itself. Preserve disagreement until the designated decision stage.
- A judge selects or coherently synthesizes against an explicit rubric. It must address review blockers rather than average incompatible proposals.
- Deterministic tests or evidence checks should occur before judgment and be passed to the judge as facts.

## Failure semantics

Choose topology with recovery in mind. Use all-success when a missing branch invalidates the result. Use quorum only when missing branches are tolerable and visible. Bound loops so persistent rejection becomes a useful terminal result rather than infinite work. Keep stable step ids so inspect can return copyable Targets for retry, steer, signal, or fork.
