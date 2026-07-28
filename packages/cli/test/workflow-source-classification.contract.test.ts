import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWorkflowForCli } from "../src/workflow-preparation.js";
import { withAuthoringTestWorkspace } from "./support/workspace.js";

describe("CLI workflow source classification contracts", () => {
  it("lets the compiler snapshot a global catalog entry outside the workspace", async () => {
    await withAuthoringTestWorkspace("workflow-source-global-classification", async (workspace, home) => {
      await withProcessHome(home, async () => {
        const packageRoot = join(home, ".acpus", "workflows", "global-snapshot");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "workflow.ts"), [
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "global-snapshot" }).build(() => ({ ready: true }));',
          "",
        ].join("\n"));

        const result = await prepareWorkflowForCli({
          workspaceDir: workspace,
          workflow: "global-snapshot",
          global: true,
        });

        expect(result.catalog).toMatchObject({
          scope: "global",
          name: "global-snapshot",
        });
        expect(result.prepared.source).toMatchObject({
          kind: "snapshot",
          digest: result.prepared.sourceGraphDigest,
        });
        if (result.prepared.source.kind !== "snapshot") throw new Error("expected snapshot source");
        expect(result.prepared.sourceBundle?.files.map(file => file.path))
          .toContain(result.prepared.source.entry);
      });
    });
  });
});

async function withProcessHome(home: string, fn: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}
