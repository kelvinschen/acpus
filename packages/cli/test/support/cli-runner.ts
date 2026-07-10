import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const sourceCli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

export function runSourceCli(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
  return runProcess(process.execPath, [
    "--conditions=development",
    "--import",
    tsxImport,
    sourceCli,
    ...args,
  ], { cwd, ...(options.env ? { env: options.env } : {}) });
}

function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
  return new Promise(resolveProcess => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("close", exitCode => resolveProcess({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}
