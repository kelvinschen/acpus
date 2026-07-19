import { writeFile } from "node:fs/promises";
import { tryCompileWorkflowModule } from "./module.js";
import type { CompileWorkerEnvelope } from "./worker.js";

const [entry, out, cwd] = process.argv.slice(2);

if (!entry || !out || !cwd) {
  console.error("Usage: compile-worker <entry> <out> <cwd>");
  process.exit(2);
}

try {
  const result = await tryCompileWorkflowModule(entry, cwd);
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
