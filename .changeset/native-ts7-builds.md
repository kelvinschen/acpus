---
"@acpus/agent-executor": patch
"acpus": patch
"@acpus/core": patch
"@acpus/expression": patch
"@acpus/loader": patch
"@acpus/runtime": patch
"@acpus/tasks": patch
"@acpus/web": patch
"@acpus/workflow-compiler": patch
---

Move the workspace build to incremental TypeScript 7 project references,
upgrade the web bundle to Vite 8, and run workflow checks through the pinned
TypeScript 7 native analysis API.
