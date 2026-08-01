---
"@acpus/runtime": minor
"acpus": minor
---

Replace fork seed planning with direct-parent, leaf-ready replay keyed by each
occurrence's effective operation and declared logical inputs. Fork children now
start pending with empty scheduler state, `--target` is an exclusive parent
checkpoint, and the unsafe-reuse option is removed.
