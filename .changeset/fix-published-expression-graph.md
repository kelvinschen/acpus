---
"@acpus/agent-executor": patch
"acpus": patch
"@acpus/core": patch
"@acpus/expression": minor
"@acpus/loader": patch
"@acpus/runtime": patch
"@acpus/tasks": patch
"@acpus/web": patch
"@acpus/workflow-compiler": patch
---

Republish the alpha package graph so runtime consumers resolve an
`@acpus/expression/ir` entrypoint that exports `isJsonValue`.
