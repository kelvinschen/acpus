import { task, z } from "@acpus/core";
import type { TaskToken } from "@acpus/core";

type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

const conflictSecond: ReusableTask<{}, { value: string }> = task.define({
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  exec: async () => ({ value: "same" }),
});

export default conflictSecond;
