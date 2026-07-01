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
        input: { repo, path: worktree, ref: "HEAD", detach: true, forceRemove: false },
        $: createDollar({ cwd: root, env: testGitEnv() }),
        artifact: {} as never,
        env: {},
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        ok: true,
        repoPath: repo,
        worktreePath: worktree,
        ref: "HEAD",
        baseSha: head,
        detached: true,
        created: true,
        dirtyStatus: "",
      });
      await expect(git(worktree, "rev-parse", "HEAD")).resolves.toMatchObject({ stdout: head + "\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dirty source repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-dirty-"));
    try {
      const { repo, worktree } = await tinyRepo(root);
      await writeFile(join(repo, "dirty.txt"), "dirty\n");

      await expect(createWorktree.fn({
        input: { repo, path: worktree },
        $: createDollar({ cwd: root, env: testGitEnv() }),
        artifact: {} as never,
        env: {},
        abortSignal: new AbortController().signal,
      })).rejects.toThrow("dirty repository");
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

      await expect(createWorktree.fn({
        input: { repo, path: worktree, forceRemove: true },
        $: createDollar({ cwd: root, env: testGitEnv() }),
        artifact: {} as never,
        env: {},
        abortSignal: new AbortController().signal,
      })).rejects.toThrow("not a registered worktree");
      await expect(access(join(worktree, "keep.txt"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-detached worktree creation in the first version", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-create-worktree-branch-"));
    try {
      const { repo, worktree } = await tinyRepo(root);

      await expect(createWorktree.fn({
        input: { repo, path: worktree, detach: false },
        $: createDollar({ cwd: root, env: testGitEnv() }),
        artifact: {} as never,
        env: {},
        abortSignal: new AbortController().signal,
      })).rejects.toThrow("only supports detached");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
