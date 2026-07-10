---
"@acpus/runtime": patch
"@acpus/workflow-compiler": patch
---

Remove redundant direct dependencies on `@acpus/tasks`; dynamic authoring facade resolution remains owned by `@acpus/loader`.
