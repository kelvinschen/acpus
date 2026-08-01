---
"@acpus/runtime": patch
---

Reject targeted cancellation of terminal nodes before planning descendant
events so inspection of completed parallel and fanout work remains read-only.
