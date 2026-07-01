import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { task, z } from "@acpus/core";
import type { TaskToken } from "@acpus/core";
import type { Dollar } from "@acpus/core/runtime";

export type CreateWorktreeInput = {
  repo: string;
  path: string;
  ref?: string | undefined;
  detach?: boolean | undefined;
  forceRemove?: boolean | undefined;
};

export type CreateWorktreeOutput = {
  ok: boolean;
  repoPath: string;
  worktreePath: string;
  ref: string;
  baseSha: string;
  detached: boolean;
  created: boolean;
  dirtyStatus: string;
};

type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

export const createWorktree: ReusableTask<CreateWorktreeInput, CreateWorktreeOutput> = task.define({
  inputSchema: z.object({
    repo: z.path(),
    path: z.path(),
    ref: z.string().optional(),
    detach: z.boolean().optional(),
    forceRemove: z.boolean().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    repoPath: z.string(),
    worktreePath: z.string(),
    ref: z.string(),
    baseSha: z.string(),
    detached: z.boolean(),
    created: z.boolean(),
    dirtyStatus: z.string(),
  }),
  exec: async ({ input, $ }) => {
    const repoPath = resolve(input.repo);
    const worktreePath = resolve(input.path);
    const ref = input.ref ?? "HEAD";
    const detached = input.detach ?? true;
    if (!detached) throw new Error("createWorktree only supports detached worktrees in this version.");

    const topLevel = (await $`git -C ${repoPath} rev-parse --show-toplevel`.text()).trim();
    const baseSha = (await $`git -C ${repoPath} rev-parse --verify ${`${ref}^{commit}`}`.text()).trim();
    const dirtyStatus = (await $`git -C ${repoPath} status --porcelain`.text()).trim();
    if (dirtyStatus) throw new Error(`Refusing to create worktree from dirty repository '${topLevel}'.`);
    if (worktreePath === resolve(topLevel)) throw new Error("Refusing to use the source repository as the worktree path.");

    if (input.forceRemove) await removeExistingWorktree($, topLevel, worktreePath);

    await $`git -C ${topLevel} worktree add --detach ${worktreePath} ${baseSha}`;

    return {
      ok: true,
      repoPath: topLevel,
      worktreePath,
      ref,
      baseSha,
      detached,
      created: true,
      dirtyStatus,
    };
  },
});

async function removeExistingWorktree($: Dollar, repo: string, worktreePath: string): Promise<void> {
  const registered = await registeredWorktrees($, repo);
  if (registered.has(worktreePath)) {
    await $`git -C ${repo} worktree remove --force ${worktreePath}`;
    return;
  }
  if (await pathExists(worktreePath)) {
    throw new Error(`Refusing to remove '${worktreePath}' because it is not a registered worktree for '${repo}'.`);
  }
}

async function registeredWorktrees($: Dollar, repo: string): Promise<Set<string>> {
  const text = await $`git -C ${repo} worktree list --porcelain`.text();
  return new Set(text.split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => resolve(line.slice("worktree ".length).trim())));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
