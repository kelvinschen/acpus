import { task, z } from "@acpus/core";

export default task.define({
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  exec: async () => ({ ok: true }),
});
