#!/usr/bin/env node
import { runCli } from "./program.js";

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
}).then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
