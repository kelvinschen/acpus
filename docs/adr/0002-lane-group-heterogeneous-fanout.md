# Lane-Group Heterogeneous Fanout

Status: accepted for planned implementation

## Decision

Planned heterogeneous fanout uses `laneGroups[]` as the canonical authoring shape. Each group expands fanout items independently under an explicit selection mode. This keeps the API honest about cardinality: `all` means all matching lanes may run; `oneOf` means exactly one lane must be selected for each item. Until this capability ships, current fanout behavior remains defined by `specs/workflow-spec.md`.

## Considered Options

- Keep the current single `fanout.role` shape and add a role selector.
- Use top-level `allLanes` / `oneOfLanes` fields.
- Use `lanes[]` plus an external `laneSelection` mode.
- Use `laneGroups[]` with each group carrying its own `mode`.

## Consequences

The first implementation is a breaking schema migration, not a compatibility layer. Homogeneous fanout should also be expressed as a single lane group.

Runtime identity must include item id, group id, and lane id. Run-index state remains item-centric with nested groups and lanes; the scheduler flattens those records into work units.

The first version keeps the model narrow: group modes are limited to `all` and `oneOf`; groups expand independently; stage-level prompt and variables remain shared defaults; lane `when` reuses the existing condition DSL; all lanes in a fanout stage must resolve to the same output contract; fanout concurrency remains a stage-level pool shared by all expanded lane work units.
