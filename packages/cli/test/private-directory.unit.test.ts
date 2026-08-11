import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateAcpusDirectory, removePrivateTree } from "../src/platform/private-directory.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe("private Acpus home directories", () => {
  it.runIf(process.platform !== "win32")("tightens every existing Acpus-owned directory in the path", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpus-private-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const acpusHome = join(home, ".acpus");
    const tmp = join(acpusHome, "tmp");
    const target = join(tmp, "workflow-imports");

    try {
      await mkdir(tmp, { recursive: true });
      await chmod(acpusHome, 0o777);
      await chmod(tmp, 0o755);

      await ensurePrivateAcpusDirectory(target);

      for (const directory of [acpusHome, tmp, target]) {
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects an Acpus-owned intermediate symlink", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpus-private-home-"));
    const outside = await mkdtemp(join(tmpdir(), "acpus-private-outside-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const acpusHome = join(home, ".acpus");
    await mkdir(acpusHome);
    await symlink(outside, join(acpusHome, "tmp"), "dir");

    try {
      await expect(ensurePrivateAcpusDirectory(join(acpusHome, "tmp", "workflow-imports")))
        .rejects.toThrow();
      await expect(lstat(join(outside, "workflow-imports"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("removes copied trees whose files and directories are read-only", async () => {
    const parent = await mkdtemp(join(tmpdir(), "acpus-private-cleanup-"));
    const root = join(parent, "snapshot");
    const nested = join(root, "package", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "workflow.ts"), "export default {};\n");
    await chmod(join(nested, "workflow.ts"), 0o400);
    await chmod(nested, 0o500);
    await chmod(join(root, "package"), 0o500);
    await chmod(root, 0o500);

    try {
      await removePrivateTree(root);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(parent, 0o700);
      await rm(parent, { recursive: true, force: true });
    }
  });
});
