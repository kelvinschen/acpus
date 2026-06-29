#!/usr/bin/env node
import { startSupervisorLoop } from "@acpus/runtime";

const [cwdArg, heartbeatMsArg] = process.argv.slice(2);
const cwd = cwdArg ?? process.cwd();
const heartbeatMs = Number(heartbeatMsArg ?? 1_000);
const loop = await startSupervisorLoop(cwd, {
  heartbeatMs,
  packageVersion: "0.6.0-alpha",
  onShutdown: () => {
    process.exit(0);
  },
});

async function shutdown(): Promise<void> {
  await loop.shutdown();
}

process.once("SIGTERM", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});

process.once("SIGINT", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});
