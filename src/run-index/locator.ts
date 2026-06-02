import fs from "node:fs/promises";
import path from "node:path";

export type RunLocator = {
  cwd: string;
  runId: string;
  dir: string;
};

export async function resolveRunLocator(locator: string, cwd = process.cwd()): Promise<RunLocator> {
  const candidate = path.resolve(cwd, locator);
  try {
    const stat = await fs.stat(candidate);
    const dir = stat.isDirectory() ? candidate : path.dirname(candidate);
    await fs.access(path.join(dir, "run.json"));
    const runsDir = path.dirname(dir);
    const orchestratorDir = path.dirname(runsDir);
    return {
      cwd: path.dirname(orchestratorDir),
      runId: path.basename(dir),
      dir
    };
  } catch {
    return {
      cwd,
      runId: locator,
      dir: path.join(cwd, ".acpus", "runs", locator)
    };
  }
}
