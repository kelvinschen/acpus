---
"acpus": patch
"@acpus/agent-executor": patch
---

Fix daemon and agent worker startup failures after a fresh install by depending directly on the exact Effect Node runtime package. Remove the intermediate platform dependency whose shared-package range could install an incompatible Effect RC.
