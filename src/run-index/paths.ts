import path from "node:path";

export function repoOrCwd(cwd = process.cwd()): string {
  return path.resolve(cwd);
}

export function orchestratorDir(cwd = process.cwd()): string {
  return path.join(repoOrCwd(cwd), ".acpus");
}

export function draftsDir(cwd = process.cwd()): string {
  return path.join(orchestratorDir(cwd), "drafts");
}

export function projectWorkflowsDir(cwd = process.cwd()): string {
  return path.join(orchestratorDir(cwd), "workflows");
}

export function globalWorkflowsDir(home = process.env.HOME ?? process.cwd()): string {
  return path.join(home, ".acpus", "workflows");
}

export function runsDir(cwd = process.cwd()): string {
  return path.join(orchestratorDir(cwd), "runs");
}

export function runDir(runId: string, cwd = process.cwd()): string {
  return path.join(runsDir(cwd), runId);
}
