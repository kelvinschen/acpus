import { writeFile } from "node:fs/promises";
import { tryCompileWorkflowModule } from "./module.js";

const [entry, out, cwd] = process.argv.slice(2);

if (!entry || !out || !cwd) {
  console.error("Usage: compile-worker <entry> <out> <cwd>");
  process.exit(2);
}

try {
  const result = await tryCompileWorkflowModule(entry, cwd);
  if (result.isErr()) {
    await writeFile(out, `${JSON.stringify({
      ok: false,
      type: result.error.type,
      message: result.error.message,
    }, null, 2)}\n`);
    process.exit(1);
  }
  await writeFile(out, `${JSON.stringify({ ok: true, ...result.value }, null, 2)}\n`);
} catch (error) {
  await writeFile(out, `${JSON.stringify({
    ok: false,
    type: "worker-system-failed",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exit(1);
}
