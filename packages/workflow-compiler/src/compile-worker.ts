import { writeFile } from "node:fs/promises";
import { compileWorkflowModule } from "./compiler/module.js";

const [entry, sourcePath, out, cwd, conditionsJson] = process.argv.slice(2);

if (!entry || !sourcePath || !out || !cwd) {
  console.error("Usage: compile-worker <entry> <sourcePath> <out> <cwd> [conditionsJson]");
  process.exit(2);
}

try {
  const conditions = conditionsJson ? JSON.parse(conditionsJson) as string[] : undefined;
  const ir = await compileWorkflowModule(entry, {
    sourcePath,
    cwd,
    ...(conditions ? { conditions } : {}),
  });
  await writeFile(out, `${JSON.stringify(ir, null, 2)}\n`);
} catch (error) {
  await writeFile(out, `${JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }, null, 2)}\n`);
  process.exit(1);
}
