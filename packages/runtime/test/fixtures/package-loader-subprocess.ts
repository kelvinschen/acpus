import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import { executeTaskNode } from "../../src/execution/task-executor.js";
import { withTaskExecutorWorkspace } from "../support/task-executor-fixture.js";

const coreSourceUrl = new URL("../../../core/src/index.ts", import.meta.url).href;

await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
  const packageDir = join(workspace, "node_modules", "fallback-task-package");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "fallback-task-package",
    type: "module",
    exports: {
      "./task": {
        development: "./task.ts",
        default: "./dist/missing.js",
      },
      "./throwing": {
        development: "./task.ts",
        default: "./throwing.js",
      },
    },
  }));
  await writeFile(join(packageDir, "task.ts"), [
    `import { task, z } from ${JSON.stringify(coreSourceUrl)};`,
    "export const fallbackTask = task.define({",
    "  inputSchema: z.object({ value: z.string() }),",
    "  exec: async ({ input }) => ({ ok: true, value: 'dev:' + input.value }),",
    "});",
  ].join("\n"));
  await writeFile(join(packageDir, "throwing.js"), "throw new Error('default exploded');\n");
  await writeFile(join(workspace, "workflow.ts"), "");

  const execution = await executeTaskNode(
    packageTask("fallback", "fallback-task-package/task"),
    {},
    taskOptions("run_1"),
  );
  if (execution.isErr()) throw new Error(execution.error.message);
  const output = execution.value;
  if (output === undefined
    || output === null
    || typeof output !== "object"
    || Array.isArray(output)
    || output.value !== "dev:loaded") {
    throw new Error("development export fallback was not used");
  }

  let masked = false;
  try {
    const throwingExecution = await executeTaskNode(
      packageTask("throwing", "fallback-task-package/throwing"),
      {},
      taskOptions("run_2"),
    );
    if (throwingExecution.isErr()) {
      if (!throwingExecution.error.message.includes("default exploded")) {
        throw new Error(throwingExecution.error.message);
      }
    } else {
      masked = true;
    }
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("default exploded")) {
      throw error;
    }
  }
  if (masked) throw new Error("development fallback masked a module evaluation error");
});

function packageTask(id: string, specifier: string): TaskNodeIR {
  return {
    id,
    kind: "task",
    run: {
      input: {
        value: { kind: "literal", value: "loaded" },
      },
      target: {
        kind: "module",
        specifier,
        exportName: "fallbackTask",
        referrer: { path: "workflow.ts" },
      },
    },
  };
}
