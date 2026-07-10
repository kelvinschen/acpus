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
- The package MUST expose `tryCreateWorktree(input, dollar)` from `@acpus/tasks/git` for typed worktree domain execution.
- `tryCreateWorktree(...)` MUST return a neverthrow `ResultAsync<CreateWorktreeOutput, CreateWorktreeError>`.
- `CreateWorktreeError` MUST be a serializable tagged union covering non-detached worktree requests, dirty source repositories, source repository paths used as worktree paths, unregistered worktree removal, and git command failures.
- `createWorktree.fn(...)` MUST return the successful
  `tryCreateWorktree(...)` output or throw an `Error` carrying the task-domain
  failure message.
- The task MUST refuse to remove an existing path during `forceRemove` unless that path is registered as a Git worktree for the source repository.

## Verification

- Tests MUST cover the public `@acpus/tasks/git` subpath exports.
- Tests MUST cover successful detached worktree creation.
- Tests MUST cover typed dirty repository failures.
- Tests MUST cover non-worktree `forceRemove` refusal and non-detached request refusal.
- Type tests MUST cover the public `tryCreateWorktree(...)` signature and `CreateWorktreeError` tags.
