import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveIsolatedWorkspaceRoot } from "../tasks.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("authoring evaluation workspace isolation", () => {
  it("requires an absolute workspace root", async () => {
    await expect(resolveIsolatedWorkspaceRoot("relative", "/workspace", "/workspace/skill"))
      .rejects.toThrow("workspaceRoot must be an absolute path");
  });

  it("rejects physical overlap through symlinks", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "repo");
    const skill = join(workspace, "skill");
    const alias = join(root, "workspace-alias");
    await mkdir(skill, { recursive: true });
    await symlink(workspace, alias, "dir");

    await expect(resolveIsolatedWorkspaceRoot(join(alias, "trials"), workspace, skill))
      .rejects.toThrow("must not contain or be contained");
    await expect(resolveIsolatedWorkspaceRoot(join(workspace, "..trials"), workspace, skill))
      .rejects.toThrow("must not contain or be contained");
    await expect(resolveIsolatedWorkspaceRoot(root, workspace, skill))
      .rejects.toThrow("must not contain or be contained");
  });

  it("accepts and canonicalizes an external absolute root", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "repo");
    const skill = join(workspace, "skill");
    const external = await temporaryRoot();
    await mkdir(skill, { recursive: true });

    await expect(resolveIsolatedWorkspaceRoot(join(external, "trials"), workspace, skill))
      .resolves.toBe(join(external, "trials"));
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "acpus-authoring-isolation-"));
  cleanup.push(path);
  return path;
}
