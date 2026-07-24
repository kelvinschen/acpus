import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

export async function treeFingerprint(root: string): Promise<string> {
  const records: string[] = [];
  await visit(root, root, records, false);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

export async function runtimeStateFingerprint(root: string): Promise<string> {
  const records: string[] = [];
  await visit(root, root, records, true);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

async function visit(
  root: string,
  path: string,
  records: string[],
  ignoreSqliteCoordination: boolean,
): Promise<void> {
  const info = await lstat(path);
  const name = relative(root, path).split(/[\\/]/).join("/") || ".";
  if (ignoreSqliteCoordination && name.endsWith("runtime.db-shm")) return;
  if (ignoreSqliteCoordination && name.endsWith("runtime.db-wal") && info.isFile() && info.size === 0) return;
  const mode = (info.mode & 0o777).toString(8);
  if (info.isSymbolicLink()) {
    records.push(`${name}\tsymlink\t${mode}\t${await readlink(path)}`);
    return;
  }
  if (info.isDirectory()) {
    records.push(`${name}\tdirectory\t${mode}`);
    for (const child of (await readdir(path)).sort()) {
      await visit(root, join(path, child), records, ignoreSqliteCoordination);
    }
    return;
  }
  if (info.isFile()) {
    const bytes = await readFile(path);
    records.push(`${name}\tfile\t${mode}\t${bytes.byteLength}\t${
      createHash("sha256").update(bytes).digest("hex")
    }`);
    return;
  }
  records.push(`${name}\tother\t${mode}\t${info.size}`);
}
