---
"acpus": minor
---

Replace the separate `workflow list` and `workflow show` commands with `workflow catalog [name]`. An omitted name opens an interactive terminal picker or prints a path-free list when piped, while a provided or selected name uses strict entry lookup with concise, semantic-color TTY details that honor `NO_COLOR`.

Add semantic TTY colors to the aligned Doctor report while keeping piped, `NO_COLOR`, and JSON output unstyled.
