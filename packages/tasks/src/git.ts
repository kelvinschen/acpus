import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { task, z } from "@acpus/core";
import type { Dollar } from "@acpus/core/runtime";
import { err, ok, ResultAsync, type Result } from "neverthrow";

const createWorktreeInputSchema = z.object({
  repo: z.string(),
  path: z.string(),
  ref: z.string().optional(),
  forceRemove: z.boolean().optional(),
});

type CreateWorktreeInput = z.infer<typeof createWorktreeInputSchema>;

type CreateWorktreeOutput = {
  repoPath: string;
  worktreePath: string;
  ref: string;
  baseSha: string;
};

type CreateWorktreeError =
  | { type: "dirty-repository"; repoPath: string; dirtyStatus: string; message: string }
  | { type: "source-repository-worktree-path"; repoPath: string; worktreePath: string; message: string }
  | { type: "unregistered-worktree-removal"; repoPath: string; worktreePath: string; message: string }
  | { type: "worktree-path-inspection-failed"; worktreePath: string; message: string }
  | { type: "git-command-failed"; message: string };

/**
 * Reusable Task token that creates a detached Git worktree from a clean source repository.
 *
 * Use it from a workflow Task node with `{ task: createWorktree, input: ... }`.
 */
export const createWorktree = task.define({
  inputSchema: createWorktreeInputSchema,
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

function tryCreateWorktree(input: CreateWorktreeInput, $: Dollar): ResultAsync<CreateWorktreeOutput, CreateWorktreeError> {
  return ResultAsync.fromPromise(
    createWorktreeResult(input, $),
    cause => ({ type: "git-command-failed", message: causeMessage(cause) } satisfies CreateWorktreeError),
  ).andThen(result => result);
}

async function createWorktreeResult(input: CreateWorktreeInput, $: Dollar): Promise<Result<CreateWorktreeOutput, CreateWorktreeError>> {
  const repoPath = resolve(input.repo);
  const worktreePath = resolve(input.path);
  const ref = input.ref ?? "HEAD";

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
    repoPath: topLevel,
    worktreePath,
    ref,
    baseSha,
  });
}

async function removeExistingWorktree($: Dollar, repo: string, worktreePath: string): Promise<Result<void, CreateWorktreeError>> {
  const registered = await registeredWorktrees($, repo);
  if (registered.has(worktreePath)) {
    await $`git -C ${repo} worktree remove --force ${worktreePath}`;
    return ok(undefined);
  }
  const inspected = await inspectPath(worktreePath);
  if (inspected.isErr()) return err(inspected.error);
  if (inspected.value) {
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

async function inspectPath(path: string): Promise<Result<boolean, CreateWorktreeError>> {
  try {
    await lstat(path);
    return ok(true);
  } catch (error) {
    if (isMissingPathError(error)) return ok(false);
    return err({
      type: "worktree-path-inspection-failed",
      worktreePath: path,
      message: `Worktree path '${path}' could not be inspected: ${causeMessage(error)}`,
    });
  }
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingPathError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
