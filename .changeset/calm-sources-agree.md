---
"@acpus/workflow-compiler": patch
---

Reject observed workflow entry changes between static checking and successful
module compilation with a typed compile-phase failure, preventing prepared IR
and lock metadata from silently combining persistent source generations.
