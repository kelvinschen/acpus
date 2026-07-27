---
"@acpus/web": patch
---

Validate every successful browser JSON response against its Web-owned result
shape before exposing it to React Query, so malformed `2xx` payloads fail with
the existing typed transport error instead of reaching UI rendering.
