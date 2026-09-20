---
"acpus": patch
---

Make MCP inspection wait until the requested decision or terminal state unless an explicit timeout is supplied, removing the implicit 30-second deadline and timeout cap. Clarify that agents should execute explicit control requests directly and resolve unknown targets without waiting.
