---
"acpus": patch
"@acpus/core": patch
"@acpus/runtime": patch
---

Add the Acpus hook system with YAML configuration, command handlers, injector and event payload types, frozen per-run hook config, hook journaling, and `acpus hooks` inspection commands. Workflows can now be submitted with `--skip-hooks` to disable hook loading and execution for a single new run.
