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
      const writtenDesigns: string[] = [];
      const artifact = {
        write: async (_name: string, content: string) => {
          writtenDesigns.push(content);
          return designSpec;
        },
        path: () => {
          throw new Error("artifact.path is not used");
        },
      };
      const result = await prepareReportInputs.fn({
        input: {
          format: "md",
          reportLanguage: "en",
          reportPath: "deliverables/report.md",
          runId: "run_1",
          workspaceDir: workspace,
        },
        artifact,
        $: undefined as never,
        env: {},
        abortSignal: new AbortController().signal,
      });
      await prepareReportInputs.fn({
        input: {
          format: "html",
          reportLanguage: "zh-CN",
          reportPath: "deliverables/report.html",
          runId: "run_2",
          workspaceDir: workspace,
        },
        artifact,
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
      expect(writtenDesigns).toHaveLength(2);
      expect(writtenDesigns[0]).toContain("Agent-led publication method");
      expect(writtenDesigns[0]).toContain("fresh perspectives");
      expect(writtenDesigns[0]).toContain("fenced Mermaid diagram");
      expect(writtenDesigns[0]).toContain("Do not force a fixed number of sections");
      expect(writtenDesigns[1]).toContain("first-screen answer");
      expect(writtenDesigns[1]).toContain("Inline SVG is encouraged");
      expect(writtenDesigns[1]).toContain("Source images or source figures are optional");
      expect(writtenDesigns[1]).toContain("data-URI images only");
      expect(writtenDesigns[1]).toContain("Use `zh-CN` for every reader-facing string");
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
