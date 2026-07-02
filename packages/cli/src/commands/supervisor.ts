import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function ensureSupervisorRunning(cwd: string): void {
  const child = spawn(process.execPath, supervisorEntryArgs(cwd), {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function supervisorEntryArgs(cwd: string): string[] {
  const isSourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`../supervisor-entry.${isSourceMode ? "ts" : "js"}`, import.meta.url));
  return isSourceMode
    ? ["--conditions=development", "--import", import.meta.resolve("tsx"), entry, cwd]
    : [entry, cwd];
}
