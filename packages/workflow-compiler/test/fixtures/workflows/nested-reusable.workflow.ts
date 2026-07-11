import { defineWorkflow } from "acpus/core";
import localDependencyTask from "./tasks/local-dependency.task.js";
import nodeModuleDependencyTask from "./tasks/node-module-dependency.task.js";

export default defineWorkflow({ name: "nested-reusable" }).build(({ step }) => {
  step("route").if({
    condition: true,
    then() {
      step("nested_local").task({
        task: localDependencyTask, input: { packageName: "acpus" },
      });
      return {};
    },
    else() {
      step("nested_node_module").task({
        task: nodeModuleDependencyTask, input: { path: "." },
      });
      return {};
    },
  });
  return {};
});
