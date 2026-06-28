import { task, z } from "@acpus/core";
import { slugifyPackageName } from "./slug.js";

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
    const slug = slugifyPackageName(normalized);

    log.info("Normalized package", { normalized, slug });

    return { normalized, slug };
  },
});
