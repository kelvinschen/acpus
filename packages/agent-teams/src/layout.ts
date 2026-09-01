import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type TeamLayout = Readonly<{
  root: string;
  statePath: string;
  workersRoot: string;
  sessionsRoot: string;
}>;

export function createTeamLayout(cwd: string, input: Readonly<{
  statePath?: string;
  home?: string;
}> = {}): TeamLayout {
  const canonicalCwd = realpathSync(resolve(cwd));
  if (input.statePath !== undefined) {
    const statePath = resolve(input.statePath);
    const root = dirname(statePath);
    ensureDirectory(root);
    return layout(root, statePath);
  }

  const home = resolve(input.home ?? process.env.ACP_TEAMS_HOME ?? join(homedir(), ".acpus", "agent-teams"));
  const workspace = createHash("sha256")
    .update(`acp-agent-teams-v1\0${process.platform}\0${canonicalCwd}`)
    .digest("hex")
    .slice(0, 32);
  const directoryId = `team_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const root = join(home, "workspaces", workspace, "teams", directoryId);
  makePrivate(root);
  return layout(root, join(root, "team.sqlite"));
}

function layout(root: string, statePath: string): TeamLayout {
  const workersRoot = join(root, "acp", "workers");
  const sessionsRoot = join(root, "acp", "sessions");
  makePrivate(workersRoot);
  makePrivate(sessionsRoot);
  return { root, statePath, workersRoot, sessionsRoot };
}

function makePrivate(path: string): void {
  ensureDirectory(path);
  chmodSync(path, 0o700);
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Agent Team directory '${path}' must be a real directory.`);
  }
}
