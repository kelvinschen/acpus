import type { TaskFunction } from "@acpus/core/runtime";
import { loadSerializedFunction } from "@acpus/expression/evaluator";

export async function loadInlineTaskFunction(source: string): Promise<TaskFunction<unknown, unknown>> {
  return loadSerializedFunction(source) as TaskFunction<unknown, unknown>;
}
