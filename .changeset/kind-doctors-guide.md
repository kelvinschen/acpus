---
"@acpus/runtime": patch
"acpus": patch
---

Report older Acpus Runtime storage as a recoverable Doctor warning. Doctor now
explains that the workspace remains usable and reports successful checks with
warnings while preserving failures for invalid or newer database formats.
