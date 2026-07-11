import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDollar } from "@acpus/core/runtime";
import { createWorktree } from "../src/git.js";
import { createWorktree as publicCreateWorktree } from "@acpus/tasks/git";

const exec = promisify(execFile);

describe("createWorktree", () => {
  it("is exported through the public git subpath", () => {
    expect(publicCreateWorktree.kind).toBe("external");
    expect(publicCreateWorktree).toBe(createWorktree);
  });

  it("creates a detached worktree from a tiny local repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-"));
    try {
      const repo = join(root, "repo");
      const worktree = join(root, "worktree");
      await git(root, "init", "repo");
      await writeFile(join(repo, "README.md"), "ok\n");
      await git(repo, "add", "README.md");
      await git(repo, "-c", "user.name=Acpus Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
      const { stdout } = await git(repo, "rev-parse", "HEAD");
      const head = stdout.trim();

      const result = await createWorktree.fn({
        input: { repo, path: worktree, ref: "HEAD", forceRemove: false },
        $: createDollar({ cwd: root, env: testGitEnv() }),
        artifact: {} as never,
        env: {},
        abortSignal: new AbortController().signal,
      });

      expect(result).toEqual({
        repoPath: repo,
        worktreePath: worktree,
        ref: "HEAD",
        baseSha: head,
      });
      await expect(git(worktree, "rev-parse", "HEAD")).resolves.toMatchObject({ stdout: head + "\n" });
      await expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).resolves.toMatchObject({ stdout: "HEAD\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses dirty source repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-dirty-result-"));
    try {
      const { repo, worktree } = await tinyRepo(root);
      await writeFile(join(repo, "dirty.txt"), "dirty\n");

      await expect(runCreateWorktree(root, { repo, path: worktree })).rejects.toThrow(
        `Refusing to create worktree from dirty repository '${repo}'.`,
      );
      await expect(access(worktree)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses forceRemove for non-worktree directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-force-"));
    try {
      const { repo, worktree } = await tinyRepo(root);
      await mkdir(worktree);
      await writeFile(join(worktree, "keep.txt"), "keep\n");

      await expect(runCreateWorktree(root, { repo, path: worktree, forceRemove: true })).rejects.toThrow("not a registered worktree");
      await expect(access(join(worktree, "keep.txt"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to replace the source repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-source-"));
    try {
      const { repo } = await tinyRepo(root);
      await expect(runCreateWorktree(root, { repo, path: repo })).rejects.toThrow("Refusing to use the source repository as the worktree path");
      await expect(access(join(repo, "README.md"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("force removes and recreates a registered worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-recreate-"));
    try {
      const { repo, worktree, head } = await tinyRepo(root);
      await runCreateWorktree(root, { repo, path: worktree });

      await expect(runCreateWorktree(root, { repo, path: worktree, forceRemove: true })).resolves.toEqual({
        repoPath: repo,
        worktreePath: worktree,
        ref: "HEAD",
        baseSha: head,
      });
      await expect(git(worktree, "rev-parse", "HEAD")).resolves.toMatchObject({ stdout: head + "\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runCreateWorktree(
  root: string,
  input: Parameters<typeof createWorktree.fn>[0]["input"],
): ReturnType<typeof createWorktree.fn> {
  return createWorktree.fn({
    input,
    $: createDollar({ cwd: root, env: testGitEnv() }),
    artifact: {} as never,
    env: {},
    abortSignal: new AbortController().signal,
  });
}

async function tinyRepo(root: string): Promise<{ repo: string; worktree: string; head: string }> {
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  await git(root, "init", "repo");
  await writeFile(join(repo, "README.md"), "ok\n");
  await git(repo, "add", "README.md");
  await git(repo, "-c", "user.name=Acpus Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
  const { stdout } = await git(repo, "rev-parse", "HEAD");
  return { repo, worktree, head: stdout.trim() };
}

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, env: { ...process.env, ...testGitEnv() } });
}

function testGitEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "Acpus Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Acpus Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}
