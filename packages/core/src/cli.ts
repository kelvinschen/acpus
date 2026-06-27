#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileWorkflowModule } from "./compiler.js";

function usage(): never {
  console.error(`Usage: acpus-core <workflow.js> [--out path] [--pretty]\n\nExamples:\n  node dist/cli.js dist/examples/release.workflow.js --pretty\n  tsx src/cli.ts examples/release.workflow.ts --out examples/release.ir.json --pretty`);
  process.exit(2);
}

const args = process.argv.slice(2);
const entry = args[0];
if (!entry || entry.startsWith("--")) usage();

let out: string | undefined;
let pretty = false;
for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--pretty") pretty = true;
  else if (arg === "--out") out = args[++i];
  else usage();
}

const ir = await compileWorkflowModule(entry, { sourcePath: entry });
const json = JSON.stringify(ir, null, pretty ? 2 : 0);
if (out) {
  const path = resolve(out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${json}\n`, "utf8");
  console.log(path);
} else {
  console.log(json);
}
