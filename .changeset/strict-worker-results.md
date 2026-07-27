---
"@acpus/workflow-compiler": patch
---

Reject compile-worker success results that omit Core validation findings or
contain malformed serialized diagnostics. Preserve validation-consistent error
IR as a compile success so preparation continues to report it in the validate
phase.
