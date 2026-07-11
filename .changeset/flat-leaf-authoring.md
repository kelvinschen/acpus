---
"@acpus/core": minor
"@acpus/workflow-compiler": patch
"acpus": minor
---

Flatten Agent, Task, and Signal workflow authoring specs by moving execution
fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
`node.run` envelopes unchanged while updating task source analysis, bundled
examples, and authoring guidance to the single flat syntax.
