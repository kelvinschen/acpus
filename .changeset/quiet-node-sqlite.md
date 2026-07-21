---
"@acpus/agent-executor": patch
"@acpus/core": patch
"@acpus/expression": patch
"@acpus/loader": patch
"@acpus/runtime": patch
"@acpus/tasks": patch
"@acpus/web": patch
"@acpus/workflow-compiler": patch
"acpus": patch
---

Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
