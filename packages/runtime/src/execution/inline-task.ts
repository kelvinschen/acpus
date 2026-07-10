import type { TaskFunction } from "@acpus/core/runtime";

export async function loadInlineTaskFunction(source: string): Promise<TaskFunction<unknown, unknown>> {
  const mod = await import(`data:text/javascript,${encodeURIComponent(`const __name = (target, _name) => target;\nexport default ${source};`)}`);
  const fn = mod.default;
  if (typeof fn !== "function") throw new Error("Inline task source did not evaluate to a function.");
  return fn as TaskFunction<unknown, unknown>;
}
