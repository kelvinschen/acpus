# PRD: Lane-group Heterogeneous Fanout

> Roadmap: this document describes planned heterogeneous fanout capability. It is not current implementation truth.

## Problem Statement

Workflow authors need fanout workflows that can assign different roles or agents to the same fanout item, or choose one role or agent per item based on item data. The current fanout model binds one stage to one role, prompt, contract, and policy, so authors cannot express cross-agent review, specialist routing, or mixed per-item handling without awkward stage duplication or hiding dispatch inside prompts.

This is especially limiting for review, research, and design-to-code workflows where item-level parallelism is still the right abstraction, but homogeneous fanout is too coarse.

## Solution

Introduce Heterogeneous Fanout as a lane-group based fanout model. A fanout stage declares non-empty `laneGroups`; each Lane Group has a selection mode and non-empty Lanes. `all` groups run all matching lanes for an item, while `oneOf` groups require exactly one lane for an item. Multiple Lane Groups may exist in one fanout stage, but the first version expands each group independently and does not support dependencies between groups.

The canonical authoring API is `laneGroups[]`. The legacy single-role fanout shape is not retained because the capability has not shipped and maintaining two APIs would add avoidable schema, compiler, and runtime cost. Homogeneous fanout is represented as a single Lane Group with one Lane.

The runtime keeps fanout item state item-centric, with nested groups and lanes for reporting and aggregation. The scheduler may flatten those records into work units. Fanout aggregate output exposes both nested item/group/lane output and a flat lane-output list for reducers and transforms.

## User Stories

1. As a workflow author, I want one fanout stage to run multiple agents against the same item, so that I can get cross-agent review without duplicating the workflow graph.
2. As a workflow author, I want one fanout stage to choose exactly one specialist agent per item, so that each item is routed to the most relevant reviewer.
3. As a workflow author, I want `all` and `oneOf` to be explicit Lane Group modes, so that the cardinality of lane selection is clear from the workflow.
4. As a workflow author, I want `all` groups to run all matching lanes, so that high-risk items can receive extra review while ordinary items receive basic review.
5. As a workflow author, I want `oneOf` groups to hard error when multiple lanes match, so that accidental overlapping routing rules do not silently run extra agents.
6. As a workflow author, I want `oneOf` groups to hard error when no lane matches and no default exists, so that missing routing coverage is visible.
7. As a workflow author, I want a default lane in `oneOf`, so that unmatched items can still be handled intentionally.
8. As a workflow author, I want default lanes to be unambiguous fallbacks, so that they do not also carry matching predicates.
9. As a workflow author, I want non-default `oneOf` lanes to declare `when`, so that always-matching lanes do not mask routing mistakes.
10. As a workflow author, I want `all` groups to allow zero matches, so that optional extra processing can be expressed without blocking an item.
11. As a workflow author, I want an item with no matching lanes in any group to be skipped, so that no-op items are visible without being treated as completed work.
12. As a workflow author, I want skipped fanout items to be excluded from completion ratios, so that partial policy is based on active work rather than no-op items.
13. As a workflow author, I want stage-level prompt defaults, so that common prompt text does not need to be duplicated across lanes.
14. As a workflow author, I want lane-level prompt overrides, so that one lane can ask for a different focus while sharing the same item source.
15. As a workflow author, I want variables to remain stage-level in the first version, so that prompt construction stays predictable.
16. As a workflow author, I want lane predicates to reuse the existing condition DSL, so that routing conditions behave like existing workflow conditions.
17. As a workflow author, I want all lanes in a fanout stage to resolve to the same output contract, so that downstream reducers receive a stable shape.
18. As a workflow author, I want contract mismatches to fail linting, so that invalid heterogeneous fanout is caught before runtime.
19. As a workflow author, I want read-only and edit lanes to be allowed in one fanout stage, so that advanced workflows can deliberately mix behavior when needed.
20. As a workflow author, I want any edit lane to mark the whole fanout as edit-risky, so that reconcile requirements still protect downstream workflow quality.
21. As a workflow author, I want fanout concurrency to stay stage-level, so that adding more Lane Groups does not unexpectedly multiply parallel agent work.
22. As a workflow author, I want `maxFanoutItems` to remain an item safety cap, so that large item sources are still bounded before lane expansion.
23. As a CLI user, I want preview output to estimate expanded work units, so that I understand the cost of lane expansion before running.
24. As a CLI user, I want validation errors for malformed Lane Groups, so that broken fanout specs fail before execution.
25. As a runtime operator, I want session keys to include item id, group id, and lane id, so that each lane attempt is traceable.
26. As a runtime operator, I want filesystem paths to use safe path segments, so that artifacts remain robust even if identifiers evolve.
27. As a report reader, I want fanout details grouped by item, then group, then lane, so that I can understand what happened to each item.
28. As a report reader, I want a flat lane-output view available to reducers, so that programmatic processing does not need to walk a nested report shape.
29. As a report reader, I want skipped item counts shown separately, so that no-op items are not confused with completed or blocked work.
30. As a report reader, I want partial item outputs to name blocked or failed lanes, so that partial completion is auditable.
31. As a workflow maintainer, I want homogeneous fanout to use the same Lane Group model, so that the implementation has one fanout path.
32. As a workflow maintainer, I want no legacy single-role compatibility layer, so that the schema and compiler stay simple before the capability ships.
33. As a workflow maintainer, I want Lane Group ids unique within a fanout stage, so that persisted identity is stable.
34. As a workflow maintainer, I want Lane ids unique only within their group, so that natural lane names can be reused across groups.
35. As a workflow maintainer, I want resume skip behavior to stay item-level in the first version, so that partial lane skip semantics do not expand the state machine.
36. As a scheduler maintainer, I want run-index state to remain item-centric, so that aggregation and reports can summarize work from the user’s perspective.
37. As a scheduler maintainer, I want execution to flatten item/group/lane records into work units internally, so that the existing fanout pool model can evolve without exposing scheduler internals.
38. As a test author, I want high-level preview, validation, runtime, resume, and report seams, so that tests cover external behavior rather than implementation details.
39. As a documentation maintainer, I want planned heterogeneous fanout to remain in roadmap documents until implemented, so that specs remain current implementation truth.
40. As an agent using the workflow system, I want stable prompt, contract, session, and output metadata per lane, so that downstream diagnosis is repairable.

## Implementation Decisions

- The fanout authoring API for this capability is `laneGroups[]`; each Lane Group declares an `id`, `mode`, and non-empty `lanes`.
- The first supported Lane Group modes are `all` and `oneOf`.
- A fanout stage may declare multiple Lane Groups, but the first version expands them independently. Groups cannot depend on, reference, order, or consume outputs from other groups.
- The legacy single-role fanout shape is not retained. Homogeneous fanout is represented by a single Lane Group containing a single Lane.
- `laneGroups` must be non-empty, and every group must contain at least one Lane.
- The first version does not add Lane Group or Lane display fields such as `description` or `label`; ids are used for report, session, and output identity.
- Fanout stage-level prompt remains as the default prompt for lanes. A Lane may override the prompt.
- Lane-level variables are out of the first version. Fanout variables remain stage-level and shared by all lanes.
- Lane `when` predicates reuse the existing condition DSL and evaluation semantics.
- `all` groups enable every matching Lane for each item. A Lane without `when` is always enabled in `all`.
- `all` groups may match zero lanes for an item. Zero matches do not produce work and do not block the item by themselves.
- `oneOf` groups require exactly one selected Lane for each item. Non-default lanes must declare `when`.
- `oneOf` groups may declare at most one default Lane. Default lanes may not declare `when`.
- `default: true` is valid only in `oneOf` groups and is invalid in `all` groups.
- `oneOf` multiple matches are fixed hard errors in the first version. No `onMultipleMatches` field is exposed.
- `oneOf` no-match without default is a hard error that blocks the fanout item. A future `zeroOrOne` mode can cover optional single selection if needed.
- If an item produces no work unit across all Lane Groups, the item is marked skipped with stable reason `NO_MATCHING_LANES`.
- Fanout item status uses the existing stage status set. Partial lane completion is represented in item output metadata rather than by adding a new status.
- Fanout partial policy remains stage-level in the first version. Lane Group-level partial policy is out of scope.
- Skipped items are excluded from fanout completion ratio and partial-policy calculations, and skipped item counts are reported separately.
- `maxConcurrency` remains a fanout stage-level pool shared by all expanded item/group/lane work units.
- `maxFanoutItems` remains a candidate item safety cap and does not limit expanded lane work units.
- Preview and reports should expose estimated expanded work unit counts.
- All lanes in a fanout stage must resolve to the same output contract using existing role category contract inference. Contract mismatches are lint errors.
- Different lane role modes are allowed. If any lane is edit-capable, the whole fanout stage is treated as edit fanout risk and must be followed by read-only reduce/reconcile.
- The framework does not prevent mixed edit and read-only lanes from running in the same fanout stage. Workflow authors own workspace race risk through item and lane design.
- Runtime identity includes item id, group id, and lane id.
- Run metadata and session keys preserve original group and lane ids; artifact paths use safe path segments.
- Run-index state remains item-centric with nested group and lane records. The scheduler may flatten those records into executable work units.
- Fanout aggregate output provides both nested item/group/lane structure and flat `laneOutputs`.
- Resume policy supports item-level skip only in the first version. Group-level and lane-level skip are deferred.
- The implementation must update the relevant specifications in the same change that turns this roadmap behavior into current behavior.

## Testing Decisions

- Good tests should assert observable workflow behavior: validation results, compiled plan shape, scheduler state transitions, run-index artifacts, aggregate outputs, resume behavior, and report projections. They should avoid testing private helper implementation details unless no higher seam can expose the behavior.
- Schema and validation tests should cover non-empty `laneGroups`, group mode values, lane uniqueness rules, `oneOf` default rules, required `when` rules, invalid `default` placement, and prompt requirements.
- Lint tests should cover contract consistency across lanes, edit fanout reconcile requirements, duplicate group ids, duplicate lane ids within a group, and invalid mixed contract roles.
- Compilation tests should cover prompt inheritance, lane prompt overrides, inferred contracts, session templates, work-unit metadata, item caps, and concurrency planning.
- Runtime scheduler tests should cover `all` expansion, `oneOf` selection, multiple-match hard errors, no-match item blocking, all-groups no-match item skipping, lane failure aggregation, partial fanout policy, and stage-level concurrency across all expanded work units.
- Resume tests should cover item-level skip with Lane Groups and confirm that group/lane-level skip is not accepted in the first version.
- Report and preview tests should cover expanded work-unit estimates, skipped item counts, nested item/group/lane display, flat lane output availability, partial lane metadata, and edit fanout risk surfacing.
- Output contract tests should cover same-contract lane outputs, contract mismatch lint errors, aggregate nested output shape, and `laneOutputs` shape.
- CLI lifecycle tests should cover validate, preview, run, resume, and report flows with at least one heterogeneous fanout workflow.
- Prior art exists in the current compiler lint, compile-plan, run-view, resume-policy, runtime stability, report projection, and CLI lifecycle test suites. New tests should extend those seams rather than introduce a separate fanout-specific harness unless the existing seams cannot express the behavior.

## Out of Scope

- Publishing this PRD to an issue tracker.
- Implementing Heterogeneous Fanout in this change.
- Updating current specifications before implementation begins.
- Supporting `zeroOrOne` groups.
- Supporting group dependencies, ordering, or output consumption between Lane Groups.
- Supporting Lane Group-level partial policy.
- Supporting group-level or lane-level resume skip.
- Supporting lane-level variables.
- Supporting explicit contract fields or per-lane contract normalization.
- Supporting per-group, per-lane, or per-agent concurrency limits.
- Adding `maxWorkUnits` as a first-version safety cap.
- Preserving the legacy single-role fanout API as a compatibility layer.
- Preventing workspace races when edit and read-only lanes are mixed.
- Adding display-only Lane or Lane Group labels.

## Further Notes

This PRD follows the repository glossary for Heterogeneous Fanout, Lane, and Lane Group. It is aligned with the accepted lane-group heterogeneous fanout ADR and the roadmap capability-gap document. Current implementation truth remains in the specifications until this planned capability is implemented and the relevant specs are updated in the same change.
