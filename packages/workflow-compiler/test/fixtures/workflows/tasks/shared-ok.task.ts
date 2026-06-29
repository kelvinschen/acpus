import { task, z, type InferSchema, type TaskToken } from "@acpus/core";

const SharedOkInput = z.object({});
const SharedOkOutput = z.object({ ok: z.boolean() });
type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

const sharedOk: ReusableTask<InferSchema<typeof SharedOkInput>, InferSchema<typeof SharedOkOutput>> = task.define({
  inputSchema: SharedOkInput,
  outputSchema: SharedOkOutput,
  exec: async () => ({ ok: true }),
});

export default sharedOk;
