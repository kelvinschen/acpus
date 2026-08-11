import { describe, expect, it } from "vitest";
import * as git from "@acpus/tasks/git";

describe("tasks public API", () => {
  it("exports the reusable worktree token through the public git subpath", () => {
    expect(Object.keys(git)).toEqual(["createWorktree"]);
    expect(git.createWorktree.kind).toBe("external");
  });
});
