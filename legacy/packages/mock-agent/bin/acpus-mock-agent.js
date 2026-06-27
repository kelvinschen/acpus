#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = resolve(import.meta.dirname, "../dist/index.js");

if (!existsSync(entry)) {
  console.error(
    "acpus-mock-agent is not built yet. Run `pnpm --filter @acpus/mock-agent build` first."
  );
  process.exit(1);
}

await import(pathToFileURL(entry).href);
