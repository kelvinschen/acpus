---
"@acpus/runtime": patch
"acpus": patch
---

Shorten run-scoped occurrence digests from twelve to eight lowercase hex characters across `@ref` selectors, exact instance keys, and every validation grammar, keeping collision resolution fail-closed. Render first attempts as bare `@ref` selectors and append `#attemptNo` only from the second attempt, drop the per-candidate `Select:` hint commands from ambiguous candidate views, and show artifact sources as their readable occurrence plus attempt instead of the full diagnostic key.
