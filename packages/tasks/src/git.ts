import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { task, z } from "@acpus/core";
import type { Dollar } from "@acpus/core/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

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
    const result = await Effect.runPromise(Effect.result(tryCreateWorktree(input, $)));
    return Result.match(result, {
      onSuccess: output => output,
      onFailure: error => {
        throw new Error(error.message);
      },
    });
  },
});

function tryCreateWorktree(input: CreateWorktreeInput, $: Dollar): Effect.Effect<CreateWorktreeOutput, CreateWorktreeError> {
  return Effect.tryPromise({
    try: () => createWorktreeResult(input, $),
    catch: cause => ({ type: "git-command-failed", message: causeMessage(cause) } satisfies CreateWorktreeError),
  }).pipe(Effect.flatMap(Effect.fromResult));
}

async function createWorktreeResult(input: CreateWorktreeInput, $: Dollar): Promise<Result.Result<CreateWorktreeOutput, CreateWorktreeError>> {
  const repoPath = resolve(input.repo);
  const worktreePath = resolve(input.path);
  const ref = input.ref ?? "HEAD";

  const topLevel = (await $`git -C ${repoPath} rev-parse --show-toplevel`.text()).trim();
  const baseSha = (await $`git -C ${repoPath} rev-parse --verify ${`${ref}^{commit}`}`.text()).trim();
  const dirtyStatus = (await $`git -C ${repoPath} status --porcelain`.text()).trim();
  if (dirtyStatus) return Result.fail({ type: "dirty-repository", repoPath: topLevel, dirtyStatus, message: `Refusing to create worktree from dirty repository '${topLevel}'.` });
  if (worktreePath === resolve(topLevel)) return Result.fail({ type: "source-repository-worktree-path", repoPath: topLevel, worktreePath, message: "Refusing to use the source repository as the worktree path." });

  if (input.forceRemove) {
    const removed = await removeExistingWorktree($, topLevel, worktreePath);
    if (Result.isFailure(removed)) return Result.fail(removed.failure);
  }

  await $`git -C ${topLevel} worktree add --detach ${worktreePath} ${baseSha}`;

  return Result.succeed({
    repoPath: topLevel,
    worktreePath,
    ref,
    baseSha,
  });
}

async function removeExistingWorktree($: Dollar, repo: string, worktreePath: string): Promise<Result.Result<void, CreateWorktreeError>> {
  const registered = await registeredWorktrees($, repo);
  if (registered.has(worktreePath)) {
    await $`git -C ${repo} worktree remove --force ${worktreePath}`;
    return Result.succeed(undefined);
  }
  const inspected = await inspectPath(worktreePath);
  if (Result.isFailure(inspected)) return Result.fail(inspected.failure);
  if (inspected.success) {
    return Result.fail({
      type: "unregistered-worktree-removal",
      repoPath: repo,
      worktreePath,
      message: `Refusing to remove '${worktreePath}' because it is not a registered worktree for '${repo}'.`,
    });
  }
  return Result.succeed(undefined);
}

async function registeredWorktrees($: Dollar, repo: string): Promise<Set<string>> {
  const text = await $`git -C ${repo} worktree list --porcelain`.text();
  return new Set(text.split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => resolve(line.slice("worktree ".length).trim())));
}

async function inspectPath(path: string): Promise<Result.Result<boolean, CreateWorktreeError>> {
  try {
    await lstat(path);
    return Result.succeed(true);
  } catch (error) {
    if (isMissingPathError(error)) return Result.succeed(false);
    return Result.fail({
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
