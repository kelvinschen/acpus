import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowReference } from "../src/catalog.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("global workflow catalog snapshots", () => {
  it("materializes one private snapshot with a durable source ref and removes it on cleanup", async () => {
    await withPlainTestWorkspace("catalog-snapshot", async (workspace, home) => {
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try {
        const packageRoot = join(home, ".acpus", "workflows", "snapshot-only");
        const workflowSource = [
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "snapshot-only" }).build(() => ({ ready: true }));',
          "",
        ].join("\n");
        const data = "snapshot bytes\n";
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "data.txt"), data);
        await writeFile(join(packageRoot, "workflow.ts"), workflowSource);

        const resolved = await resolveWorkflowReference(workspace, "snapshot-only", { global: true });
        if (resolved.sourceRoot === undefined || resolved.cleanup === undefined) {
          throw new Error("expected a materialized global catalog snapshot");
        }
        expect(resolved.catalog).toMatchObject({
          scope: "global",
          name: "snapshot-only",
          status: "available",
        });
        expect(resolved.source).toEqual({
          kind: "global_catalog",
          name: "snapshot-only",
          digest: "f9f748b6ff89cee7624c7d25bcf32080cfcfd6a997d2e4686e42c0984b51bf9e",
          entry: "workflow.ts",
        });
        expect(basename(resolved.sourceRoot)).toBe("package");
        expect(resolved.sourceRoot.startsWith(
          join(home, ".acpus", "tmp", "catalog-snapshots", "snapshot-only-"),
        )).toBe(true);
        expect(resolved.workflow).toBe(join(resolved.sourceRoot, "workflow.ts"));
        await expect(readFile(join(resolved.sourceRoot, "data.txt"), "utf8")).resolves.toBe(data);
        await expect(readFile(resolved.workflow, "utf8")).resolves.toBe(workflowSource);
        await expect(access(join(home, ".acpus", "workspaces"))).rejects.toMatchObject({ code: "ENOENT" });

        const snapshotRoot = dirname(resolved.sourceRoot);
        await resolved.cleanup();
        await expect(access(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
      }
    });
  });
});
