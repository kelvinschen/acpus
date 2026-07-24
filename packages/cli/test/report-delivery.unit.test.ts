import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareReportInputs } from "../skills/acpus/workflows/library/deep-research/tasks/report-delivery.js";

describe("deep-research report delivery", () => {
  it("keeps owned drafts in home tmp while resolving explicit reports in the workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "acpus-report-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "acpus-report-workspace-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
      const designSpec = {
        kind: "artifact",
        uri: "artifact://run_1/design",
        mediaType: "text/markdown",
      } as const;
      const result = await prepareReportInputs.fn({
        input: {
          format: "md",
          reportLanguage: "en",
          reportPath: "deliverables/report.md",
          runId: "run_1",
          workspaceDir: workspace,
        },
        artifact: {
          write: async () => designSpec,
          path: () => {
            throw new Error("artifact.path is not used");
          },
        },
        $: undefined as never,
        env: {},
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        format: "md",
        designSpec,
        draftDir: join(home, ".acpus", "tmp", "report-drafts", "run_1"),
        draftPath: join(home, ".acpus", "tmp", "report-drafts", "run_1", "report.md"),
        outputPath: join(workspace, "deliverables", "report.md"),
      });
      await expect(access(result.draftDir)).resolves.toBeUndefined();
      if (process.platform !== "win32") {
        expect((await stat(result.draftDir)).mode & 0o777).toBe(0o700);
      }
      await expect(access(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
