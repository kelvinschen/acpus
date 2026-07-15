import { task, z, type ArtifactRef } from "acpus/core";

const ReportInputSchema = z.object({
  name: z.string(),
  lines: z.array(z.string()),
});
type ReportInput = z.infer<typeof ReportInputSchema>;
type ReportResult = { artifact: ArtifactRef; lineCount: number };

export const writeReport = task.define({
  inputSchema: ReportInputSchema,
  exec: async ({ input, artifact }): Promise<ReportResult> => {
    const reportInput: ReportInput = input;
    const body = `${reportInput.lines.join("\n")}\n`;
    const output: ArtifactRef = await artifact.write(reportInput.name, body, { mediaType: "text/plain" });
    return { artifact: output, lineCount: reportInput.lines.length };
  },
});
