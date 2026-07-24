import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setRuntimeHomeForTest } from "../../src/runtime-layout.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export async function withStorageWorkspace<T>(
  name: string,
  fn: (workspace: string) => Promise<T>,
): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  const home = `${workspace}-home`;
  const restoreHome = setRuntimeHomeForTest(workspace, home);
  try {
    return await fn(workspace);
  } finally {
    restoreHome();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}

export async function withSharedStorageHome<T>(
  name: string,
  fn: (paths: { home: string; first: string; second: string }) => Promise<T>,
): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, `${name}-home-`));
  const first = await mkdtemp(join(root, `${name}-first-`));
  const second = await mkdtemp(join(root, `${name}-second-`));
  const restoreFirst = setRuntimeHomeForTest(first, home);
  const restoreSecond = setRuntimeHomeForTest(second, home);
  try {
    return await fn({ home, first, second });
  } finally {
    restoreSecond();
    restoreFirst();
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}
