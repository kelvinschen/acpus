import { task, z } from "@acpus/core";

export const NormalizePackageInput = z.object({
  packageName: z.string(),
});

export const NormalizePackageOutput = z.object({
  normalized: z.string(),
  slug: z.string(),
});

export default task.define({
  inputSchema: NormalizePackageInput,
  outputSchema: NormalizePackageOutput,
  exec: async ({ input, log }) => {
    const normalized = input.packageName.trim();
    const slug = normalized
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    log.info("Normalized package", { normalized, slug });

    return { normalized, slug };
  },
});
