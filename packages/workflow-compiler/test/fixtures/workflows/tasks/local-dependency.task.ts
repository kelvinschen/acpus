import { task, z } from "@acpus/core";
import { slugifyPackageName } from "./slug.js";

export const NormalizePackageInput = z.object({
  packageName: z.string(),
});

const localDependencyTask = task.define({
  inputSchema: NormalizePackageInput,
  exec: async ({ input }) => {
    const normalized = input.packageName.trim();
    const slug = slugifyPackageName(normalized);

    return { normalized, slug };
  },
});

export default localDependencyTask;
