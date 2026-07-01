import { task, z, type InferSchema, type TaskToken } from "@acpus/core";
import { slugifyPackageName } from "./slug.js";

export const NormalizePackageInput = z.object({
  packageName: z.string(),
});

export const NormalizePackageOutput = z.object({
  normalized: z.string(),
  slug: z.string(),
});

type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

const localDependencyTask: ReusableTask<InferSchema<typeof NormalizePackageInput>, InferSchema<typeof NormalizePackageOutput>> = task.define({
  inputSchema: NormalizePackageInput,
  outputSchema: NormalizePackageOutput,
  exec: async ({ input }) => {
    const normalized = input.packageName.trim();
    const slug = slugifyPackageName(normalized);

    return { normalized, slug };
  },
});

export default localDependencyTask;
