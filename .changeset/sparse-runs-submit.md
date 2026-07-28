---
"acpus": minor
---

Submit durable workflow runs by default and return one compact sparse-inspection
command with optional `[--follow]` guidance. Add `workflow run --follow` with a
three-second default inspection interval for blocking observation and remove
the redundant `--background` option. Compact same-target Timeline and follow
guidance into one inspect command. Structured follow output retains the
`admitted` receipt before its Runtime `snapshot`, updates, and terminal record.
