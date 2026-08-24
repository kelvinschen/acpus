#!/usr/bin/env node
import * as Effect from "effect/Effect";
import { runCli } from "./program.js";

const main = Effect.tryPromise({
  try: () => runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }),
  catch: cause => cause,
}).pipe(Effect.match({
  onFailure: error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  },
  onSuccess: code => code,
}), Effect.tap(code => Effect.sync(() => {
  process.exitCode = code;
})));

await Effect.runPromise(main);
