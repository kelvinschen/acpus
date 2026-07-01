import { defineWorkflow } from "@acpus/core";
import firstTask from "./tasks/conflict-first.task.js";
import secondTask from "./tasks/conflict-second.task.js";

export default defineWorkflow({
  name: "conflicting-bundle-metadata",
}).build(({ step }) => {
  const first = step("first").task({
    run: { task: firstTask, input: {} },
  });
  const second = step("second").task({
    run: { task: secondTask, input: {} },
  });
  return {
    first: first.output.value,
    second: second.output.value,
  };
});
