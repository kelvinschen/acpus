---
"@acpus/runtime": patch
"@acpus/web": patch
---

Project retry and cancel applicability from the Runtime control planner so Web
and inspection no longer advertise targets that control admission will reject.
Return exact retry targets with the runtime visualization snapshot and expose an
exact selected cancel target only through Runtime target inspection. Run-level
cancel now also handles a paused run whose root frame has not materialized, and
historical attempts no longer inherit controls for a later execution of the
same node. Read-side retry planning now performs the same pure failure
settlement as mutation admission without writing it, identity collisions fail
closed, and Web rejects blank control targets at its boundary.
