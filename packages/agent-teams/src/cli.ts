#!/usr/bin/env node
import * as Effect from "effect/Effect";
import { runCli } from "./program.js";

const interruption = new AbortController();
let webObserverSettled = false;
let closeWebObserver!: () => void;
const webObserverClose = new Promise<void>(resolve => {
  closeWebObserver = resolve;
});

const main = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  cliPath: process.argv[1]!,
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  webObserver: {
    markSettled: () => {
      webObserverSettled = true;
    },
    waitForClose: () => webObserverClose,
  },
}).pipe(Effect.tap(code => Effect.sync(() => {
  process.exitCode = code;
})));

let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
const interrupt = (signal: "SIGINT" | "SIGTERM") => () => {
  receivedSignal ??= signal;
  if (webObserverSettled) closeWebObserver();
  else interruption.abort(signal);
};
const onSigint = interrupt("SIGINT");
const onSigterm = interrupt("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  await Effect.runPromise(main, { signal: interruption.signal });
} catch (error) {
  if (receivedSignal === undefined) throw error;
  process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
