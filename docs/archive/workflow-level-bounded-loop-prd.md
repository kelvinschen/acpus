# PRD: Workflow-Level Bounded Loop

> Roadmap: this document describes planned Workflow-Level Bounded Loop capability. It is not current implementation truth.

## Problem Statement

Workflow authors need to express bounded, multi-stage feedback flows such as module migration, parallel worker execution, dual static and semantic review, regression fix validation, and final optimization. The current model supports a dedicated `fixLoop` shape for validator/fixer repair, but that shape cannot represent a full workflow body with fanout, reduce, decision, and review stages.

The workflow graph intentionally rejects arbitrary cycles, and that should remain true. The missing capability is not arbitrary graph recursion; it is a controlled Workflow-Level Bounded Loop with durable round history, explicit exit conditions, and predictable recovery semantics.

## Solution

Introduce `loop` as the only workflow-level cycle primitive. A loop is a top-level stage whose body is an inline scoped set of stages. The top-level workflow remains a DAG, while repeated work happens only inside the loop container.

Each loop declares a required maximum round count, a Loop Body with its own root and canonical output stage, a `continueWhen` condition, and `onExhausted: "blocked"`. Each Loop Round executes the full body, evaluates `continueWhen` at the round boundary, and either starts another round, completes the loop, or blocks when the round limit is exhausted while work still needs to continue.

The first implementation fully replaces `fixLoop`. Because the feature has not shipped, there is no compatibility layer, no `fixLoop` sugar, and no legacy authoring shape.

Parallel module migration and dual review are modeled with existing fanout, Lane Group, and reduce concepts inside the Loop Body. The loop controls rounds; fanout controls worker concurrency.

## User Stories

1. As a workflow author, I want a `loop` stage, so that I can express bounded multi-stage retry flows without arbitrary graph cycles.
2. As a workflow author, I want the top-level workflow graph to remain a DAG, so that dependency semantics stay predictable.
3. As a workflow author, I want loop stages to contain an inline Loop Body, so that repeated stages are scoped to the loop.
4. As a workflow author, I want Loop Body stage ids to be scoped, so that repeated body stages do not collide with top-level stage ids.
5. As a workflow author, I want a Loop Body root, so that each round has an explicit starting point.
6. As a workflow author, I want a Loop Body Output, so that each round has a canonical result.
7. As a workflow author, I want `maxRounds` to be required, so that loops are always bounded.
8. As a workflow author, I want `continueWhen`, so that the loop continues only when the latest round output says more work is needed.
9. As a workflow author, I want continuation evaluated only after a full Loop Round, so that partial body execution does not become hidden control flow.
10. As a workflow author, I want `continueWhen` to reuse the condition DSL, so that loop routing behaves like existing workflow conditions.
11. As a workflow author, I want `loop.current.output`, so that common continuation checks can read the Loop Body Output directly.
12. As a workflow author, I want `loop.current.outputs`, so that advanced continuation checks can read other body stage outputs from the current round.
13. As a workflow author, I want `loop.previous.output`, so that workers can see the previous round's canonical result when repairing.
14. As a workflow author, I want `loop.previous.outputs`, so that prompts can consume selected previous body stage outputs explicitly.
15. As a workflow author, I want first-round missing previous outputs to be explicit, so that prompts or defaults handle empty context intentionally.
16. As a workflow author, I want a loop to complete when `continueWhen` is false, so that successful convergence proceeds to downstream stages.
17. As a workflow author, I want a loop to block when `maxRounds` is exhausted and `continueWhen` is still true, so that unresolved work is not treated as complete.
18. As a workflow author, I want body stage blocked or failed status to block the loop, so that runtime failures are not confused with business-level retry signals.
19. As a workflow author, I want business rejection signals to be expressed in completed outputs, so that `continueWhen` controls retry behavior from structured data.
20. As a workflow author, I want the first version to allow `agentTask`, `discover`, `fanout`, `reduce`, and `decisionGate` in the Loop Body, so that existing recoverable primitives compose inside rounds.
21. As a workflow author, I want `gate` rejected inside Loop Body, so that the workflow keeps one terminal gate.
22. As a workflow author, I want nested loops rejected in the first version, so that round identity and recovery remain manageable.
23. As a workflow author, I want parallel module workers to use fanout inside the Loop Body, so that loop does not introduce a second concurrency model.
24. As a workflow author, I want fanout `maxConcurrency` to remain stage-local inside the Loop Body, so that worker concurrency is explicit.
25. As a workflow author, I want dual static and semantic review modeled as fanout Lane Groups, so that parallel review reuses existing Heterogeneous Fanout language.
26. As a workflow author, I want review findings reduced before continuation, so that the loop has one canonical retry signal.
27. As a workflow author, I want the final loop output to include the latest round summary, so that downstream stages can consume the converged result.
28. As a workflow author, I want loop output to include `finalOutputs`, so that downstream stages can read selected final body outputs.
29. As a workflow author, I want loop output to include `rounds`, so that historical retry context remains auditable.
30. As a runtime operator, I want run-index state to keep one top-level loop stage entry, so that top-level run status remains readable.
31. As a runtime operator, I want body stage state nested under loop round history, so that every repeated stage is recoverable without polluting the top-level stage map.
32. As a runtime operator, I want attempt identity to include loop id, round number, and body stage id, so that attempts are traceable.
33. As a runtime operator, I want output identity to include loop id, round number, and body stage id, so that round artifacts do not overwrite each other.
34. As a runtime operator, I want event metadata to include loop id and round number, so that reports can reconstruct round execution.
35. As a runtime operator, I want agent sessions isolated per round and body stage, so that implicit chat history does not leak across rounds.
36. As a workflow maintainer, I want cross-round context passed through variables, so that prompts state dependencies explicitly.
37. As a workflow maintainer, I want `fixLoop` removed when `loop` lands, so that the schema has one loop primitive.
38. As a workflow maintainer, I want no compatibility layer for `fixLoop`, so that unreleased API complexity does not remain in the compiler or runtime.
39. As a CLI user, I want preview to account for worst-case loop rounds, so that planned agent calls are understandable before running.
40. As a report reader, I want loop rounds displayed as history, so that I can see why a workflow retried.
41. As a report reader, I want the final round distinguished from prior rounds, so that the delivered result is clear.
42. As a report reader, I want blocked exhaustion shown distinctly, so that max-round failure is easy to diagnose.
43. As a resume user, I want an interrupted loop to resume from persisted round state, so that completed round work is not repeated unnecessarily.
44. As a resume user, I want stale recovery to respect loop attempt identity, so that recovery does not confuse repeated body stages.
45. As a test author, I want external behavior tests for schema, compilation, runtime state, resume, and report output, so that loop behavior is covered at user-visible boundaries.

## Implementation Decisions

- Add `loop` as the schema stage kind for Workflow-Level Bounded Loop.
- Remove `fixLoop` as part of the same breaking migration. Do not preserve its authoring shape, compile it as sugar, or keep runtime compatibility paths.
- Keep the top-level workflow graph acyclic. Back edges are not added to ordinary stages.
- Define Loop Body as an inline scoped graph with its own root, output, and stages.
- Require Loop Body stage ids to be unique inside the Loop Body, not globally unique across the whole workflow.
- Require `body.output` to name a body stage. This stage is the Loop Body Output.
- Allow only existing recoverable non-terminal stage kinds in the first Loop Body version: agent tasks, discovery, fanout, reduce, and decision gates.
- Reject terminal gates inside Loop Body. The workflow continues to have one top-level terminal gate.
- Reject nested loops in the first version.
- Do not add new tool task or program task support as part of the first loop implementation.
- Require `maxRounds` on every loop.
- Support `continueWhen` as the only loop continuation field in the first version.
- Do not add `exitWhen` in the first version.
- Evaluate `continueWhen` only after the full Loop Round completes.
- If `continueWhen` is false after a round, complete the loop.
- If `continueWhen` is true and more rounds remain, start the next round.
- If `continueWhen` is true after the final allowed round, block the loop with exhausted status.
- Limit first-version `onExhausted` to blocked behavior.
- Treat body stage blocked or failed status as loop blocking. Do not evaluate `continueWhen` after body runtime failure.
- Express business-level retry signals through completed structured outputs such as findings, checks, verdicts, or summaries.
- Add loop-scoped variable roots for current round output, current round outputs, previous round output, and previous round outputs.
- Make `loop.current.output` a stable alias for the current Loop Body Output.
- Make `loop.current.outputs` expose all current round body outputs.
- Make `loop.previous.output` a stable alias for the previous Loop Body Output.
- Make `loop.previous.outputs` expose all previous round body outputs.
- Let first-round previous-output sources be absent. Authors handle this through defaults or prompt logic.
- Emit one top-level Loop Output for the loop stage.
- Include latest round summary and status metadata in Loop Output.
- Include `finalOutputs` in Loop Output.
- Include complete round history metadata in Loop Output.
- Do not promote Loop Body stage outputs to top-level workflow outputs.
- Store loop as one top-level stage in the run index.
- Store body stage state nested under loop round history.
- Include loop id, round number, and body stage id in attempt, output, and event identity.
- Isolate agent sessions per loop id, round number, and body stage id.
- Pass cross-round context explicitly through loop variables rather than implicit session history.
- Use fanout inside Loop Body for parallel worker migration.
- Use Lane Group `all` fanout plus reduce for dual static and semantic review.
- Do not add a dedicated parallel review stage.
- Do not add a loop-level concurrency pool. Fanout continues to own stage-local worker concurrency.
- Estimate planned agent calls using the worst-case round count.
- Update specifications in the implementation change that makes this planned behavior current.

## Testing Decisions

- Good tests should assert observable behavior at schema validation, linting, compilation, runtime scheduling, persisted run state, resume, report projection, and CLI lifecycle boundaries.
- Schema tests should cover valid `loop` shape, required `maxRounds`, required `body.root`, required `body.output`, scoped body stage ids, allowed body stage kinds, rejected gates, rejected nested loops, and rejected `exitWhen`.
- Migration tests should assert that `fixLoop` is rejected after the breaking migration and no compatibility path remains.
- Lint tests should cover top-level DAG preservation, invalid body dependencies, invalid body output references, and terminal gate uniqueness.
- Compilation tests should cover scoped body planning, prompt variables for loop roots, planned worst-case calls, loop-scoped identity, and fanout planning inside a Loop Body.
- Runtime tests should cover completed loop convergence, multi-round continuation, exhausted blocked behavior, body blocked propagation, body failed propagation, and no mid-round break behavior.
- Runtime fanout tests should cover fanout execution inside a loop round, fanout aggregation before downstream body stages, and Lane Group review plus reduce as the continuation signal.
- Run-index tests should cover nested round state, top-level loop stage status, attempt identity, output identity, event metadata, and preservation of all round histories.
- Resume tests should cover interruption during a body stage, interruption during fanout, interruption after a completed round before continuation evaluation, and stale recovery with loop-scoped attempt identity.
- Output contract tests should cover Loop Output shape, `finalOutputs`, `rounds`, canonical Loop Body Output mapping, and absence of promoted top-level body outputs.
- Variable tests should cover `loop.current.output`, `loop.current.outputs`, `loop.previous.output`, `loop.previous.outputs`, and first-round missing previous output behavior.
- Report tests should cover round history display, final round display, exhausted blocked diagnosis, fanout details inside loop rounds, and agent usage accounting.
- CLI lifecycle tests should cover validate, preview, run, resume, follow, diagnose, and report flows for a loop workflow.
- Existing high-level test surfaces should be extended before creating a separate loop-only harness.

## Out of Scope

- Publishing this PRD to GitHub or another issue tracker.
- Implementing the feature in this documentation change.
- Updating current specifications before implementation changes current behavior.
- Supporting arbitrary top-level graph cycles.
- Supporting ordinary top-level parallel split and join as part of the first loop phase.
- Supporting selected route convergence as part of the first loop phase.
- Supporting nested loops.
- Supporting gates inside Loop Body.
- Supporting `exitWhen`.
- Supporting mid-round break or early exit from Loop Body.
- Supporting loop-level partial policy or recovery policy.
- Supporting loop-level concurrency pools.
- Supporting new native tool, MCP, program, or command task stages.
- Preserving `fixLoop` compatibility.
- Adding dedicated migration-worker or parallel-review stage kinds.
- Implicitly injecting all prior round history into prompts.

## Further Notes

This PRD follows the repository glossary terms Workflow-Level Bounded Loop, Loop Body, Loop Body Output, Loop Round, Loop Output, Heterogeneous Fanout, Lane, and Lane Group. It aligns with the accepted Workflow-Level Bounded Loop ADR and the lane-group heterogeneous fanout direction.

Current implementation truth remains in `specs/` until the planned capability is implemented. The implementation change must update the relevant specifications in the same change that modifies schema, compiler, runtime, run-index, report, output contracts, examples, or error codes.
