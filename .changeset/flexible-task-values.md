---
"@acpus/core": minor
"@acpus/runtime": minor
"@acpus/workflow-compiler": minor
"@acpus/expression": patch
"@acpus/web": patch
"acpus": patch
---

Allow inline and reusable Tasks to receive any durable value directly while
preserving precise materialized input types. Lower and execute Task input as one
expression, expose its complete authored shape in workflow visualization, and
accept interface-shaped durable results from `lift`.

Advance frozen workflow IR and Runtime storage generations so existing
generation isolation rejects the previous Task-input representation without a
compatibility shim.
