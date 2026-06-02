# Workflow Examples

Runnable spec files organized by pattern. Edit the originals in
`workflows/examples/` — this directory is a mirror.

| File | Pattern |
|------|---------|
| `simple-feature.workflow.spec.json` | Linear plan→implement→validate→gate |
| `bugfix-loop.workflow.spec.json` | Bounded quality loop with `continueWhen` |
| `loop-review-convergence.workflow.spec.json` | Loop + fanout + reduce + converge |
| `realtime-loop-fanout-review.workflow.spec.json` | Loop containing dual-lane fanout |
| `fanout/read-only-single-lane.workflow.spec.json` | Discover → single-lane fanout → reduce |
| `fanout/read-only-multi-lane-oneof-default.workflow.spec.json` | oneOf lane routing with `default` |
| `fanout/read-only-multi-lane-all-when.workflow.spec.json` | all mode with conditional lanes |
| `fanout/edit-only-single-lane.workflow.spec.json` | Edit fanout + readOnly reconcile |
