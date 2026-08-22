import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tryPrepareWorkflow } from "@acpus/workflow-compiler";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceDir = fileURLToPath(new URL("../../../", import.meta.url));
const source = await readFile(`${packageRoot}knowledge/30-examples.md`, "utf8");
const examples = [...source.matchAll(/```ts\n([\s\S]*?)\n```/gu)]
  .map(match => match[1])
  .filter(example => example?.includes("export default"));

if (examples.length === 0) throw new Error("No complete DSH knowledge examples were found.");

for (const [index, example] of examples.entries()) {
  const result = await Effect.runPromise(Effect.result(tryPrepareWorkflow({
    workspaceDir,
    source: {
      kind: "files",
      entry: "workflow.ts",
      files: [{ path: "workflow.ts", content: `${example}\n` }],
    },
  })));
  if (Result.isFailure(result)) {
    console.error(`DSH knowledge example ${index + 1} failed during ${result.failure.phase}.`);
    console.error(JSON.stringify(result.failure, null, 2));
    process.exitCode = 1;
  }
}
