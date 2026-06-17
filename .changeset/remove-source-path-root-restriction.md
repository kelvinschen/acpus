---
"@acpus/core": minor
"@acpus/runtime": minor
"@acpus/cli": patch
---

Remove source path root directory restriction: Workflow Spec source/include paths are no longer restricted to workspace/global catalog roots

- `@acpus/core`: `workflowSourcePolicy` renamed to `workflowSourceResolver`. `WorkflowSourcePolicy` type renamed to `WorkflowSourceResolver`. `allowedSourceRoots` and `isAllowedSourcePath` removed. `createIncludeResolver` no longer takes `allowedSourceRoots` parameter. `realPathOrUndefined` is now exported. Source and include paths are validated for existence and readability only, not restricted by root directory.
- `@acpus/runtime`: `allowedSourceRoots` removed from `InterpreterOptions`. Subworkflow and include path validation no longer restricts to workspace/global catalog roots — any readable filesystem path is accepted.
- `@acpus/cli`: Internal update to use `workflowSourceResolver`. Dead `createIncludeResolver` re-export removed from `io.ts`.
