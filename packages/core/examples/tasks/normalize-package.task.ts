import { task, z } from "../../src/index.js";

export const NormalizePackageInput = z.object({
  packageName: z.string(),
});

export const NormalizePackageOutput = z.object({
  normalized: z.string(),
  slug: z.string(),
});

export default task.define({
  input: NormalizePackageInput,
  output: NormalizePackageOutput,
}).run(async ({ input, log }) => {
  const normalized = input.packageName.trim();
  const slug = normalized
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  log.info("Normalized package", { normalized, slug });

  return { normalized, slug };
});
