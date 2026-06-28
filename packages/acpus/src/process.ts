import { spawn } from "node:child_process";

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runProcess(command: string, args: string[], options: { cwd?: string } = {}): Promise<ProcessResult> {
  return new Promise(resolveProcess => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("close", exitCode => resolveProcess({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.on("error", error => resolveProcess({
      exitCode: null,
      stdout: "",
      stderr: error.message,
    }));
  });
}
