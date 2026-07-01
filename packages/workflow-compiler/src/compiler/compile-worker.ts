import { writeFile } from "node:fs/promises";
import { tryCompileWorkflowModule } from "./module.js";

const [entry, sourcePath, out, cwd] = process.argv.slice(2);

if (!entry || !sourcePath || !out || !cwd) {
  console.error("Usage: compile-worker <entry> <sourcePath> <out> <cwd>");
  process.exit(2);
}

try {
  const result = await tryCompileWorkflowModule(entry, {
    sourcePath,
    cwd,
  });
  if (result.isErr()) {
    await writeFile(out, `${JSON.stringify({
      ok: false,
      type: result.error.type,
      message: result.error.message,
    }, null, 2)}\n`);
    process.exit(1);
  }
  const ir = result.value;
  await writeFile(out, `${JSON.stringify(ir, null, 2)}\n`);
} catch (error) {
  await writeFile(out, `${JSON.stringify({
    ok: false,
    type: "worker-system-failed",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }, null, 2)}\n`);
  process.exit(1);
}
