---
"@acpus/core": minor
"@acpus/agent-executor": minor
"@acpus/runtime": minor
"acpus": minor
---

Remove opt-in raw Agent Trace authoring and storage. Settled Agent turn
artifacts now reference the run-local acpx session projection, whose compact
messages, thinking, tool calls, and tool-result content are retained without
the optional full tool output.

Use short run-local ACP session identities, and treat only known routine acpx
status metadata as observation noise so unsupported provider activity remains
visible as degraded evidence.
