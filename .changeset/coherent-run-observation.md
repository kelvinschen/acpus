---
"@acpus/runtime": minor
"acpus": minor
---

Replace the public Runtime inspection APIs with `readInspection` and
`observeInspection`: one coherent, privacy-safe model for run, target Summary,
target Timeline, candidate, and append-only semantic observation views.
Observation now pins its selected subject across automatic replacement and
separates terminal waits from actionable decision boundaries.

Simplify CLI inspection to a text-only interface using public occurrence
selectors and candidate-only pagination. `--follow` now waits for the fixed
subject to become terminal, while `--await-decision` returns for input, pause,
or terminal decisions. Remove `workflow run --json`, `runs inspect --json`, and
the inspection `--all`, `--controls`, `--evidence`, `--limit`, and `--raw`
surfaces. Blocking transcripts label their attachment, omit recursive Await
navigation, and add run elapsed context only when a semantic update is emitted.

Document Steer as exceptional recovery for admitted, in-scope information
updates rather than elapsed-time or convergence pressure.
