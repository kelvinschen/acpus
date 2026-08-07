---
acpus: patch
"@acpus/runtime": patch
---

- Refine SessionGroup reuse to be atomic for each explicit `sessionKey`: members are now reused only as a whole and either fully replayed together or fully re-executed together. Mixed history+fresh execution for the same group is no longer allowed in a forked child run.
- Add group-level consistency safeguards to runtime fork/replay planning and commit paths (closed-group closure checks, identity mismatch handling, and ordering checks). Violations now either atomically fall back the whole group or fail hard, preventing partial reuse inconsistency.
- Keep non-session nodes on existing per-occurrence value-based reuse and update runtime spec/documentation to match the new SessionGroup behavior.
