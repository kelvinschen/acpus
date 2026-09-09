---
"@acpus/runtime": patch
---

Create a new child Run for each new Fork request while preserving request-ID idempotency. Preserve valid Agent union outputs before attempting schema projection, including nested unions.

Preserve Runtime metadata read errors so permission and I/O failures are reported instead of being misclassified as corrupt metadata requiring store repair.
