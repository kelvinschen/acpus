---
"acpus": patch
"@acpus/core": patch
---

Add run-before-run static validation of CEL expressions in Workflow Specs.

`acpus workflows lint` / `--dry-run` now catch common expression mistakes at
compile time instead of at runtime: field paths checked against declared
output/input/fanout-item schemas (`EXPR_UNKNOWN_FIELD`), out-of-scope `loop`/
`item` roots and not-yet-visible step references (`EXPR_ROOT_OUT_OF_SCOPE`,
`EXPR_UNKNOWN_STEP`), and non-scalar values spliced into a Program Step `cmd`
(`EXPR_NONSCALAR_IN_CMD`). Validation is fail-quiet — anything whose shape
cannot be determined statically is accepted silently and never throws — and a
single composite contract is the source of truth for each Node kind's output
projection and body-local scope, consumed by both the compiler and the
validator.
