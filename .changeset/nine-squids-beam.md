---
"acpus": patch
"@acpus/core": patch
"@acpus/runtime": patch
"@acpus/tui": patch
---

refactor: extract keys module, consolidate test projects, add agent-overrides CLI layer 
- Extract run keys (forkID, resume replay strategy) into standalone keys module 
- Consolidate vitest projects under unified test runner config 
- Add agent-overrides CLI surface with contract tests 
- Simplify agent-ensure integration tests: remove redundant assertions 
- Clean up compiler, expression-scope, interpreter, store modules 
- Expand hash unit tests with edge cases 
- Compress store fields from address/port to host/port tuple
