import { defineWorkflow, task, z } from "@acpus/core";
import notTask from "./tasks/not-a-task.task.js";
import externalTask from "external-task";

const PREFIX = "outer-";
const localTask = task.define({
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  exec: async () => ({ ok: true }),
});

export default defineWorkflow({
  name: "eslint_task_authoring_fixture",
}).build(({ step }) => {
  step("local").task({ run: { task: localTask, input: {} } });
  // @ts-expect-error Fixture intentionally passes a non-task export for TB005.
  step("invalid_export").task({ run: { task: notTask, input: {} } });
  step("third_party").task({ run: { task: externalTask, input: {} } });
  step("inline_capture").task({
    outputSchema: z.object({ slug: z.string() }),
    run: { input: {}, exec: async () => ({ slug: `${PREFIX}value` }) },
  });

  return { ok: true };
});
