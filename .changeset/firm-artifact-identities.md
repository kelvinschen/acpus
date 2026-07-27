---
"@acpus/runtime": patch
---

Bind Runtime storage roots, run capsules, resolved ArtifactRefs, Task and Agent
artifacts, Private Turn Evidence, and Trace files to their observed filesystem
identities. Fail closed on same-path replacement, missing stable inode identity,
or an orphan run capsule requiring operator inspection instead of adopting or
deleting an ambiguous path. Keep Agent artifact paths isolated by attempt id,
fence verified reads around their open file descriptor, and retain a durably
registered artifact when a later identity checkpoint fails.
