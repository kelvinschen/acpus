---
"@acpus/agent-executor": minor
"@acpus/runtime": minor
"acpus": minor
---

Run each ACP Agent attempt in an owned worker process, with bounded best-effort
cleanup and startup recovery for recorded worker ownership. Runtime now exposes
optional ACP silence information, can fail an attempt after a configured
inactivity boundary, and reports only unresolved ACP ownership through Doctor.

Daemon lease and status metadata now report the installed CLI package version
instead of a stale alpha value.
