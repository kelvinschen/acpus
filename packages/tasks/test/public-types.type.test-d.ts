import { expectTypeOf, test } from "vitest";
import { createWorktree } from "@acpus/tasks/git";

test("@acpus/tasks/git exposes the reusable worktree token", () => {
  expectTypeOf(createWorktree.kind).toEqualTypeOf<"external">();
  expectTypeOf<Parameters<typeof createWorktree.fn>[0]["input"]>().toEqualTypeOf<{
    repo: string;
    path: string;
    ref?: string | undefined;
    forceRemove?: boolean | undefined;
  }>();
  expectTypeOf<Awaited<ReturnType<typeof createWorktree.fn>>>().toEqualTypeOf<{
    repoPath: string;
    worktreePath: string;
    ref: string;
    baseSha: string;
  }>();
});
