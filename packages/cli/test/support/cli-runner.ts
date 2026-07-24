import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const sourceCli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const testHomes = new Map<string, string>();

export function registerTestProcessHome(cwd: string, home: string): () => void {
  const key = resolve(cwd);
  testHomes.set(key, home);
  return () => {
    if (testHomes.get(key) === home) testHomes.delete(key);
  };
}

export async function runSourceCli(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
  const registeredHome = testHomes.get(resolve(cwd));
  const temporaryRoot = join(repoRoot, ".tmp-tests");
  if (!registeredHome) await mkdir(temporaryRoot, { recursive: true });
  const home = registeredHome ?? await mkdtemp(join(temporaryRoot, "cli-home-"));
  try {
    return await runProcess(process.execPath, [
      "--conditions=development",
      "--import",
      tsxImport,
      sourceCli,
      ...args,
    ], {
      cwd,
      env: {
        HOME: home,
        USERPROFILE: home,
        ...options.env,
      },
    });
  } finally {
    if (!registeredHome) await rm(home, { recursive: true, force: true });
  }
}

function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
  return new Promise(resolveProcess => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, FORCE_COLOR: "0" };
    delete env.NODE_NO_WARNINGS;
    delete env.NODE_OPTIONS;
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env,
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
