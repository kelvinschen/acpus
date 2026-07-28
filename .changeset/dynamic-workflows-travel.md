---
"@acpus/core": patch
"@acpus/runtime": minor
"@acpus/web": patch
"@acpus/workflow-compiler": minor
"acpus": minor
---

Accept workflow sources outside the workspace and from standard input without
writing generated source into the project. Capture their static local module
closure as a content-addressed bundle, persist it during Runtime admission, and
restore reusable Tasks from the durable snapshot while retaining the workspace
as the command and package-dependency authority.
