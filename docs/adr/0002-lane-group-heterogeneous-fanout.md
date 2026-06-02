# Lane-group heterogeneous fanout

Status: accepted for planned implementation

We decided that planned heterogeneous fanout should use `laneGroups[]` as the canonical authoring shape, with each group independently expanding fanout items under an explicit selection mode. This keeps the API honest about cardinality: `all` means all matching lanes may run, while `oneOf` means exactly one lane must be selected for each item. Until this capability is implemented, current fanout behavior remains defined by `specs/workflow-spec.md`.

**Considered Options**

- Keep the current single `fanout.role` shape and add a role selector.
- Use top-level `allLanes` / `oneOfLanes` fields.
- Use `lanes[]` plus an external `laneSelection` mode.
- Use `laneGroups[]` with each group carrying its own `mode`.

**Consequences**

The first implementation should be a breaking schema migration rather than a compatibility layer: homogeneous fanout should also be expressed as a single lane group. Runtime identity needs to include item id, group id, and lane id; run-index state should remain item-centric with nested groups and lanes, while the scheduler can flatten those records into work units.

The first version intentionally keeps the model narrow: group modes are limited to `all` and `oneOf`; groups expand independently; stage-level prompt and variables remain shared defaults; lane `when` reuses the existing condition DSL; all lanes in a fanout stage must resolve to the same output contract; and fanout concurrency remains a stage-level pool shared by all expanded lane work units.
