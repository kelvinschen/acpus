import { task, z, type InferSchema, type TaskToken } from "@acpus/core";
import slash from "slash";

// Reusable task that imports a third-party dependency directly. The
// compiler must bundle that dependency graph into the frozen task asset.
const NormalizePathInput = z.object({ path: z.string() });
const NormalizePathOutput = z.object({ normalized: z.string() });
type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

const nodeModuleDependencyTask: ReusableTask<InferSchema<typeof NormalizePathInput>, InferSchema<typeof NormalizePathOutput>> = task.define({
  inputSchema: NormalizePathInput,
  outputSchema: NormalizePathOutput,
  exec: async ({ input }) => ({
    normalized: slash(input.path),
  }),
});

export default nodeModuleDependencyTask;
