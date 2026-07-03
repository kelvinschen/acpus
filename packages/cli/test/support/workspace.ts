import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./cli-runner.js";

export async function withTestWorkspace<T>(name: string, fn: (workspace: string) => Promise<T>): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  try {
    await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
    await linkWorkspaceCore(workspace);
    await writeWorkspaceTsconfig(workspace);
    return await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeWorkspaceTsconfig(workspace: string): Promise<void> {
  await writeFile(join(workspace, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      customConditions: ["development"],
    },
    include: ["*.ts"],
  }, null, 2)}\n`);
}

export async function withIsolatedTestWorkspace<T>(name: string, fn: (workspace: string) => Promise<T>): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  try {
    await writeWorkspaceTsconfig(workspace);
    return await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function linkWorkspaceCore(workspace: string): Promise<void> {
  await mkdir(join(workspace, "packages"), { recursive: true });
  await symlink(join(repoRoot, "packages", "core"), join(workspace, "packages", "core"), "dir");
}
