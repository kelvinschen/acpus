import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { task, z } from "@acpus/core";
import type { Dollar } from "@acpus/core/runtime";
import { err, ok, ResultAsync, type Result } from "neverthrow";

/** Input accepted by the Git worktree reusable task. */
export type CreateWorktreeInput = {
  repo: string;
  path: string;
  ref?: string | undefined;
  detach?: boolean | undefined;
  forceRemove?: boolean | undefined;
};

/** Output returned after a Git worktree is created. */
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

/** Recoverable errors returned by the low-level Git worktree helper. */
export type CreateWorktreeError =
  | { type: "non-detached-worktree"; message: string }
  | { type: "dirty-repository"; repoPath: string; dirtyStatus: string; message: string }
  | { type: "source-repository-worktree-path"; repoPath: string; worktreePath: string; message: string }
  | { type: "unregistered-worktree-removal"; repoPath: string; worktreePath: string; message: string }
  | { type: "git-command-failed"; message: string };

/**
 * Reusable Task token that creates a detached Git worktree from a clean source repository.
 *
 * Use it from a workflow Task node with `run: { task: createWorktree, input: ... }`.
 */
export const createWorktree = task.define({
  inputSchema: z.object({
    repo: z.path(),
    path: z.path(),
    ref: z.string().optional(),
    detach: z.boolean().optional(),
    forceRemove: z.boolean().optional(),
  }),
  exec: async ({ input, $ }): Promise<CreateWorktreeOutput> => {
    const result = await tryCreateWorktree(input, $);
    return result.match(
      output => output,
      error => {
        throw new Error(error.message);
      },
    );
  },
});

/** Low-level ResultAsync helper used by `createWorktree`. */
export function tryCreateWorktree(input: CreateWorktreeInput, $: Dollar): ResultAsync<CreateWorktreeOutput, CreateWorktreeError> {
  return ResultAsync.fromPromise(
    createWorktreeResult(input, $),
    cause => ({ type: "git-command-failed", message: causeMessage(cause) } satisfies CreateWorktreeError),
  ).andThen(result => result);
}

async function createWorktreeResult(input: CreateWorktreeInput, $: Dollar): Promise<Result<CreateWorktreeOutput, CreateWorktreeError>> {
  const repoPath = resolve(input.repo);
  const worktreePath = resolve(input.path);
  const ref = input.ref ?? "HEAD";
  const detached = input.detach ?? true;
  if (!detached) return err({ type: "non-detached-worktree", message: "createWorktree only supports detached worktrees in this version." });

  const topLevel = (await $`git -C ${repoPath} rev-parse --show-toplevel`.text()).trim();
  const baseSha = (await $`git -C ${repoPath} rev-parse --verify ${`${ref}^{commit}`}`.text()).trim();
  const dirtyStatus = (await $`git -C ${repoPath} status --porcelain`.text()).trim();
  if (dirtyStatus) return err({ type: "dirty-repository", repoPath: topLevel, dirtyStatus, message: `Refusing to create worktree from dirty repository '${topLevel}'.` });
  if (worktreePath === resolve(topLevel)) return err({ type: "source-repository-worktree-path", repoPath: topLevel, worktreePath, message: "Refusing to use the source repository as the worktree path." });

  if (input.forceRemove) {
    const removed = await removeExistingWorktree($, topLevel, worktreePath);
    if (removed.isErr()) return err(removed.error);
  }

  await $`git -C ${topLevel} worktree add --detach ${worktreePath} ${baseSha}`;

  return ok({
    ok: true,
    repoPath: topLevel,
    worktreePath,
    ref,
    baseSha,
    detached,
    created: true,
    dirtyStatus,
  });
}

async function removeExistingWorktree($: Dollar, repo: string, worktreePath: string): Promise<Result<void, CreateWorktreeError>> {
  const registered = await registeredWorktrees($, repo);
  if (registered.has(worktreePath)) {
    await $`git -C ${repo} worktree remove --force ${worktreePath}`;
    return ok(undefined);
  }
  if (await pathExists(worktreePath)) {
    return err({
      type: "unregistered-worktree-removal",
      repoPath: repo,
      worktreePath,
      message: `Refusing to remove '${worktreePath}' because it is not a registered worktree for '${repo}'.`,
    });
  }
  return ok(undefined);
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

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
