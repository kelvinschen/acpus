import { task, z, type ArtifactRef } from "acpus/core";

const PublishPublicationInput = z.object({
  completed: z.boolean(),
  draftDir: z.string(),
  draftPath: z.string(),
  editorialPath: z.string(),
  format: z.enum(["md", "html"]),
  reportStem: z.string(),
});

type PublishPublicationInput = z.infer<typeof PublishPublicationInput>;

type PublishedPublication = {
  format: PublishPublicationInput["format"];
  artifact: ArtifactRef;
  editorialArtifact: ArtifactRef;
};

/** Publishes the final format and retains its authoritative Markdown source. */
export const publishPublicationDelivery = task.define({
  inputSchema: PublishPublicationInput,
  exec: async ({ input, artifact }): Promise<PublishedPublication> => {
    if (!input.completed) throw new Error("Publication cannot run before its draft is complete.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.reportStem)) {
      throw new Error("reportStem must be a lowercase kebab-case artifact name.");
    }

    const { readFile, rm } = await import("node:fs/promises");
    const editorialContent = await readFile(input.editorialPath, "utf8");
    const editorialArtifact = await artifact.write(
      `${input.reportStem}.md`,
      editorialContent,
      { mediaType: "text/markdown" },
    );
    const report = input.format === "md"
      ? editorialArtifact
      : await artifact.write(
        `${input.reportStem}.html`,
        await readFile(input.draftPath, "utf8"),
        { mediaType: "text/html" },
      );

    await rm(input.draftDir, { recursive: true, force: true }).catch(() => { });
    return { format: input.format, artifact: report, editorialArtifact };
  },
});
