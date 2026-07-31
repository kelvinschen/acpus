#!/usr/bin/env node
import { startDaemonLoop } from "@acpus/runtime";
import { getCliPackageInfo } from "./package-info.js";

const [cwdArg, heartbeatMsArg] = process.argv.slice(2);
const cwd = cwdArg ?? process.cwd();
const heartbeatMs = Number(heartbeatMsArg ?? 1_000);
const loop = await startDaemonLoop(cwd, {
  heartbeatMs,
  packageVersion: getCliPackageInfo().version,
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
