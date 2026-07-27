---
"@acpus/runtime": patch
"@acpus/web": patch
---

Project runtime node inspection into a closed Web-owned response before sending
it to the browser. Remove Runtime document markers, raw collections, internal
Agent telemetry, and registry artifact fields from the one-second Overview
poll; expose only a normalized unambiguous Signal action; and preserve exact
verified prompt text, structured failures, public artifacts, and existing
Inspector behavior. Keep context-scoped repeated Signal inspection
occurrence-exact so another occurrence's wait cannot supply its action target.
