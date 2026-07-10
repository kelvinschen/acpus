---
"@acpus/runtime": minor
---

Remove the uncontracted `RuntimeStore`, `AdvanceRunSummary`, `SchedulerStorePort`,
`AgentOverrideSpec`, `RunExecutionMetadata`, `RunDynamicGroup`, `ForkRunRecord`,
`RuntimeDiagnostics`, and `DaemonDiagnostics` type exports from the
`@acpus/runtime` package root. Their internal definitions and the durable store
port remain in use; the obsolete direct interpreter and its store APIs are
removed so runtime execution has one durable scheduler path.

Declare `@acpus/workflow-compiler` at the runtime test boundary instead of
relying on the workspace root to provide fixture compilation transitively.
