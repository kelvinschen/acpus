/*
 * Pattern: Reuse a typed Task at two authored call sites and return its artifacts.
 * Nodes: task
 */
import { defineWorkflow, z } from "acpus/core";
import { writeReport } from "./tasks.js";

export default defineWorkflow({
  name: "reusable-task-artifact",
  inputSchema: z.object({
    summary: z.array(z.string()),
    audit: z.array(z.string()),
  }),
}).build(({ input, step }) => {
  const summary = step("write_summary").task({
    task: writeReport,
    input: { name: "summary.txt", lines: input.summary },
  });
  const audit = step("write_audit").task({
    task: writeReport,
    input: { name: "audit.txt", lines: input.audit },
  });

  return { summary: summary.output, audit: audit.output };
});
