import { writeFile } from "node:fs/promises";
import { tryCompileWorkflowModule } from "./module.js";
import type { CompileWorkerEnvelope } from "./worker.js";

const [entry, out, sourceRoot, dependencyRoot, expectedSourceDigest] = process.argv.slice(2);

if (!entry || !out || !sourceRoot || !dependencyRoot || !expectedSourceDigest) {
  console.error("Usage: compile-worker <entry> <out> <source-root> <dependency-root> <expected-source-digest>");
  process.exit(2);
}

try {
  const result = await tryCompileWorkflowModule(entry, sourceRoot, {
    dependencyRoot,
    expectedSourceDigest,
  });
  const envelope: CompileWorkerEnvelope = result.match(
    value => ({ schemaVersion: 1, ok: true, result: value }),
    error => ({ schemaVersion: 1, ok: false, error }),
  );
  await writeFile(out, `${JSON.stringify(envelope, null, 2)}\n`);
  if (result.isErr()) process.exitCode = 1;
} catch (error) {
  const envelope: CompileWorkerEnvelope = {
    schemaVersion: 1,
    ok: false,
    error: {
      type: "worker-system-failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
  await writeFile(out, `${JSON.stringify(envelope, null, 2)}\n`);
  process.exitCode = 1;
}
