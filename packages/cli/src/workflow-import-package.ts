import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  extractWorkflowMetadata,
  tryPrepareWorkflow,
  type PreparedWorkflow,
} from "@acpus/workflow-compiler";
import { extractWorkflowImportArchive, PathInventory } from "./workflow-import-archive.js";
import { abortImport, WorkflowImportAbort } from "./workflow-import-failure.js";
import type { AcquiredWorkflowImportSource } from "./workflow-import-source.js";
import { resolveWorkflowSourceForCli } from "./workflow-preparation.js";

export type CheckedWorkflowImportPackage = Pick<
  PreparedWorkflow,
  "sourceGraphDigest"
> & {
  diagnostics: PreparedWorkflow["ir"]["diagnostics"];
};

export async function prepareWorkflowImportPackage(
  source: AcquiredWorkflowImportSource,
  stagingRoot: string,
  stagedPackage: string,
): Promise<{ name: string }> {
  await materializePackage(source, stagingRoot, stagedPackage);
  const entryPath = join(stagedPackage, "workflow.ts");
  const metadata = await extractWorkflowMetadata(await readFile(entryPath, "utf8"), entryPath);
  if (metadata.isErr()) abortImport("IMPORT_METADATA_INVALID", metadata.error.message);
  return { name: metadata.value.name };
}

export async function checkWorkflowImportPackage(
  cwd: string,
  stagedPackage: string,
  expectedName: string,
): Promise<CheckedWorkflowImportPackage> {
  const resolved = await resolveWorkflowSourceForCli({
    workspaceDir: cwd,
    workflow: join(stagedPackage, "workflow.ts"),
  });
  const prepared = await tryPrepareWorkflow({
    workspaceDir: cwd,
    source: resolved.source,
  });
  if (prepared.isErr()) throw new WorkflowImportAbort({ type: "preparation", failure: prepared.error });
  if (prepared.value.ir.name !== expectedName) {
    abortImport("IMPORT_CHECK_NAME_MISMATCH", `Prepared workflow name '${prepared.value.ir.name}' does not match static authored name '${expectedName}'.`);
  }
  return {
    diagnostics: prepared.value.ir.diagnostics.map(diagnostic => {
      const file = diagnostic.source?.file;
      if (!file) return diagnostic;
      const packagePath = relative(stagedPackage, resolve(cwd, file));
      if (packagePath === "" || packagePath === ".." || packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath)) return diagnostic;
      return {
        ...diagnostic,
        source: { ...diagnostic.source, file: packagePath.split(sep).join("/") },
      };
    }),
    sourceGraphDigest: prepared.value.sourceGraphDigest,
  };
}

async function materializePackage(
  source: AcquiredWorkflowImportSource,
  stagingRoot: string,
  stagedPackage: string,
): Promise<void> {
  if (source.kind === "typescript") return;
  if (source.kind === "directory") {
    const packageRoot = await resolvePackageRoot(source.path);
    await copyValidatedTree(packageRoot, stagedPackage);
    return;
  }
  const unpacked = join(stagingRoot, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await extractWorkflowImportArchive(source.kind, source.path, unpacked);
  const packageRoot = await resolvePackageRoot(unpacked);
  await copyValidatedTree(packageRoot, stagedPackage);
}

async function resolvePackageRoot(root: string): Promise<string> {
  if (await isRegularFile(join(root, "workflow.ts"))) return root;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) {
    abortImport("IMPORT_PACKAGE_INVALID", "Workflow package must contain workflow.ts at its root or inside one wrapper directory.");
  }
  const wrapper = join(root, entries[0]!.name);
  if (!await isRegularFile(join(wrapper, "workflow.ts"))) {
    abortImport("IMPORT_PACKAGE_INVALID", "Workflow package wrapper must contain workflow.ts.");
  }
  return wrapper;
}

async function copyValidatedTree(sourceRoot: string, targetRoot: string): Promise<void> {
  const inventory = new PathInventory("IMPORT_PACKAGE_INVALID", "Workflow package");
  await copyDirectory(sourceRoot, targetRoot, "", inventory);
}

async function copyDirectory(source: string, target: string, relativePath: string, inventory: PathInventory): Promise<void> {
  const item = await lstat(source);
  if (!item.isDirectory()) abortImport("IMPORT_PACKAGE_INVALID", "Workflow package root must be a regular directory.");
  if (relativePath) inventory.add(relativePath.split(sep).join("/"), "directory");
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
    const child = await lstat(sourcePath);
    if (child.isSymbolicLink()) abortImport("IMPORT_PACKAGE_INVALID", `Workflow package path '${childRelative}' cannot be a symbolic link.`);
    if (child.isDirectory()) {
      await copyDirectory(sourcePath, targetPath, childRelative, inventory);
      continue;
    }
    if (!child.isFile()) abortImport("IMPORT_PACKAGE_INVALID", `Workflow package path '${childRelative}' must be a regular file or directory.`);
    if (child.nlink !== 1) abortImport("IMPORT_PACKAGE_INVALID", `Workflow package path '${childRelative}' cannot be a hard link.`);
    inventory.add(childRelative.split(sep).join("/"), "file");
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    await chmod(targetPath, child.mode & 0o777);
  }
  await chmod(target, item.mode & 0o777);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}
