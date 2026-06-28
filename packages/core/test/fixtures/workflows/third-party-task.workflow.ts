import { defineWorkflow, z } from "@acpus/core";
import checkVersion from "./tasks/check-version.task.js";

export default defineWorkflow({
  name: "third-party-task-fixture",
  inputSchema: z.object({ version: z.string() }),
}).build(({ input, step, output }) => {
  const result = step("check_version").task({
    task: checkVersion,
    input: { version: input.version },
  });

  return output({ valid: result.output.valid });
});
