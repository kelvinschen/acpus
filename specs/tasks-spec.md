# Tasks Spec

## Purpose

`@acpus/tasks` provides reusable Acpus task tokens for common local automation. User workflow modules import the official task facade through `acpus/tasks/git`. The package owns task-domain input/output contracts and typed recoverable task-domain refusals; runtime scheduling and task execution belong to `@acpus/runtime`.

## Requirements

- The package MUST expose reusable task APIs through named subpaths and MUST
  NOT expose a root `@acpus/tasks` entrypoint.
- The package MUST expose `createWorktree` from `@acpus/tasks/git` as a reusable external task token.
- The `acpus` CLI package MUST expose `createWorktree` through the
  `acpus/tasks/git` authoring facade.
- Reusable task outputs MUST be inferred from each task's `exec` return type; package tasks MUST NOT declare `outputSchema`.
- `createWorktree` MUST accept source repository path, worktree path, optional
  ref, and optional `forceRemove`; it MUST create a detached worktree.
- Successful creation MUST return the resolved repository path, resolved
  worktree path, requested ref, and resolved base commit SHA.
- Recoverable domain execution MUST remain an internal typed `ResultAsync` with
  tagged dirty-repository, source-repository-path, unregistered-removal, and Git
  command failures. The dirty-repository error MUST retain Git's dirty status.
- `createWorktree.fn(...)` MUST return the successful internal result or throw
  an `Error` carrying the task-domain failure message.
- The task MUST reject dirty source repositories and MUST reject the source
  repository itself as the requested worktree path.
- The task MUST refuse to remove an existing path during `forceRemove` unless that path is registered as a Git worktree for the source repository.

## Verification

- Tests MUST cover the public `@acpus/tasks/git` subpath exports.
- Tests MUST cover successful detached worktree creation.
- Tests MUST cover dirty repository and source repository path refusals.
- Tests MUST cover registered worktree replacement and non-worktree
  `forceRemove` refusal.
- Type tests MUST cover the public `createWorktree` input and output contract.
