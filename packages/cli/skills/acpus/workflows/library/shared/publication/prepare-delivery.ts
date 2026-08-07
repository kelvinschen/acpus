import { task, z } from "acpus/core";

const PublicationDeliveryInput = z.object({
  format: z.enum(["md", "html"]),
  runId: z.string(),
});

type PublicationDeliveryInput = z.infer<typeof PublicationDeliveryInput>;

type PublicationDelivery = {
  draftDir: string;
  editorialPath: string;
  htmlPath: string;
};

export const preparePublicationDelivery = task.define({
  inputSchema: PublicationDeliveryInput,
  exec: async ({ input }): Promise<PublicationDelivery> => {
    const { chmod, lstat, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { isAbsolute, relative, resolve, sep } = await import("node:path");
    const draftRoot = resolve(tmpdir(), "acpus-report-drafts");
    const draftDir = resolve(draftRoot, input.runId);
    const relativeDraft = relative(draftRoot, draftDir);
    if (!relativeDraft || relativeDraft === ".." || relativeDraft.startsWith(`..${sep}`) || isAbsolute(relativeDraft)) {
      throw new Error("runId must identify one internal report draft directory.");
    }
    const uid = process.platform === "win32" ? undefined : process.getuid?.();
    for (const directory of [draftRoot, draftDir]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST") throw error;
      }
      const item = await lstat(directory);
      if (item.isSymbolicLink() || !item.isDirectory()) {
        throw new Error(`Acpus-owned path '${directory}' is not a regular directory.`);
      }
      if (uid !== undefined && item.uid !== uid) {
        throw new Error(`Acpus-owned path '${directory}' is owned by another user.`);
      }
      if (process.platform !== "win32") await chmod(directory, 0o700);
    }
    return {
      draftDir,
      editorialPath: resolve(draftDir, input.format === "html" ? "publication-draft.md" : "report.md"),
      htmlPath: resolve(draftDir, "index.html"),
    };
  },
});
