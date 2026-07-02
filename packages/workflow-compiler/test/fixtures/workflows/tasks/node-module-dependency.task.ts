import { task, z } from "@acpus/core";
import slash from "slash";

// Reusable task that keeps a third-party dependency as a live runtime module
// dependency.
const NormalizePathInput = z.object({ path: z.string() });

const nodeModuleDependencyTask = task.define({
  inputSchema: NormalizePathInput,
  exec: async ({ input }) => ({
    normalized: slash(input.path),
  }),
});

export default nodeModuleDependencyTask;
