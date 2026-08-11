import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Acpus-owned path '${path}' is not a regular directory.`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function ensurePrivateAcpusDirectory(path: string): Promise<void> {
  const root = resolve(homedir(), ".acpus");
  const target = resolve(path);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Acpus-owned path '${path}' is outside '${root}'.`);
  }

  await ensurePrivateDirectory(root);
  let current = root;
  for (const part of child.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    await ensurePrivateDirectory(current);
  }
}

export async function removePrivateTree(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
    return;
  } catch {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeRemovable(path: string): Promise<void> {
  let item;
  try {
    item = await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  if (!item.isDirectory()) {
    if (!item.isSymbolicLink()) await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await makeRemovable(join(path, name));
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}
