import { task, z } from "@acpus/core";
import { z as zodDirect } from "zod";

// Reusable task that imports a third-party dependency (zod) directly. The
// compiler must bundle that dependency graph into the frozen task asset.
const VersionSchema = zodDirect.string().regex(/^\d+\.\d+\.\d+$/);

export default task.define({
  inputSchema: z.object({ version: z.string() }),
  outputSchema: z.object({ valid: z.boolean() }),
  exec: async ({ input }) => ({ valid: VersionSchema.safeParse(input.version).success }),
});
