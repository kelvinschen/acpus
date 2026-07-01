import { expectTypeOf, test } from "vitest";
import type { ResultAsync } from "neverthrow";
import type { Dollar } from "@acpus/core/runtime";
import type { CreateWorktreeError, CreateWorktreeInput, CreateWorktreeOutput } from "@acpus/tasks/git";
import { createWorktree, tryCreateWorktree } from "@acpus/tasks/git";

test("@acpus/tasks/git public types describe typed worktree failures", () => {
  expectTypeOf(createWorktree.kind).toEqualTypeOf<"external">();
  expectTypeOf(tryCreateWorktree).toEqualTypeOf<(input: CreateWorktreeInput, dollar: Dollar) => ResultAsync<CreateWorktreeOutput, CreateWorktreeError>>();
  expectTypeOf<CreateWorktreeError["type"]>().toEqualTypeOf<
    "non-detached-worktree" | "dirty-repository" | "source-repository-worktree-path" | "unregistered-worktree-removal" | "git-command-failed"
  >();
});
