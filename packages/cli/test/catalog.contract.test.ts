import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkflowCatalog, prepareWorkflowCatalogCommit } from "../src/workflow/catalog.js";
import { repoRoot } from "./support/cli-runner.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("workflow catalog discovery", () => {
  it("discovers first-level project and global workflow packages", async () => {
    await withPlainTestWorkspace("catalog-discovery", async workspace => {
      const home = await testHome("catalog-discovery-home");
      await withHome(home, async () => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "release");
        await workflowPackage(join(workspace, ".acpus", "workflows"), "shared");
        await workflowPackage(join(workspace, ".acpus", "workflows"), "parent");
        await workflowPackage(join(workspace, ".acpus", "workflows", "parent"), "nested");
        await workflowPackage(join(home, ".acpus", "workflows"), "deploy");
        await workflowPackage(join(home, ".acpus", "workflows"), "shared");
        await workflowPackage(join(home, ".acpus", "workflows"), "Bad");
        await ignoredIndexWorkflowFilePackage(join(workspace, ".acpus", "workflows"), "index-file");
        await writeFile(join(workspace, ".acpus", "workflows", "loose.workflow.ts"), workflowSource("loose"));
        await mkdir(join(workspace, ".acpus", "workflows", "empty"), { recursive: true });

        const entries = await discoverWorkflowCatalog(workspace);

        expect(entries.filter(entry => entry.status === "available").map(entry => [entry.status, entry.scope, entry.name, entry.requiresScope])).toEqual([
          ["available", "global", "deploy", false],
          ["available", "project", "parent", false],
          ["available", "project", "release", false],
          ["available", "project", "shared", true],
          ["available", "global", "shared", true],
        ]);
        const invalid = entries.filter(entry => entry.status === "invalid");
        expect(invalid.map(entry => entry.packagePath)).toEqual(invalid.map(entry => entry.packagePath).sort((left, right) => left.localeCompare(right)));
        expect(Object.fromEntries(invalid.map(entry => [basename(entry.packagePath), entry.errorCode]))).toEqual({
          Bad: "CATALOG_NAME_INVALID",
          empty: "CATALOG_ENTRY_MISSING",
          "index-file": "CATALOG_ENTRY_MISSING",
        });
        expect(entries.every(entry => entry.packagePath.startsWith("/"))).toBe(true);
        expect(entries.every(entry => entry.entryPath.endsWith("/workflow.ts"))).toBe(true);
      });
    });
  });

  it("filters by explicit catalog scope", async () => {
    await withPlainTestWorkspace("catalog-scope", async workspace => {
      const home = await testHome("catalog-scope-home");
      await withHome(home, async () => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "project-only");
        await workflowPackage(join(home, ".acpus", "workflows"), "global-only");

        await expect(discoverWorkflowCatalog(workspace, { project: true })).resolves.toMatchObject([
          { scope: "project", name: "project-only" },
        ]);
        await expect(discoverWorkflowCatalog(workspace, { global: true })).resolves.toMatchObject([
          { scope: "global", name: "global-only" },
        ]);
      });
    });
  });

  it("maps each static metadata failure to its stable catalog error code", async () => {
    await withPlainTestWorkspace("catalog-metadata-errors", async workspace => {
      const root = join(workspace, ".acpus", "workflows");
      await rawWorkflowPackage(root, "syntax", "export default (");
      await rawWorkflowPackage(root, "missing-default", 'import { defineWorkflow } from "acpus/core";');
      await rawWorkflowPackage(root, "not-static", "export default {};\n");
      await rawWorkflowPackage(root, "name-not-static", [
        'import { defineWorkflow } from "acpus/core";',
        'const name = "name-not-static";',
        "export default defineWorkflow({ name }).build(() => ({}));",
      ].join("\n"));

      const invalid = (await discoverWorkflowCatalog(workspace, { project: true }))
        .filter(entry => entry.status === "invalid");

      expect(Object.fromEntries(invalid.map(entry => [basename(entry.packagePath), entry.errorCode]))).toEqual({
        "missing-default": "CATALOG_DEFAULT_EXPORT_MISSING",
        "name-not-static": "CATALOG_NAME_NOT_STATIC",
        "not-static": "CATALOG_WORKFLOW_NOT_STATIC",
        syntax: "CATALOG_SOURCE_INVALID",
      });
    });
  });

  it("publishes exactly one complete package when prepared Acpus writers race", async () => {
    await withPlainTestWorkspace("catalog-publication-race", async workspace => {
      const home = await testHome("catalog-publication-race-home");
      await withHome(home, async () => {
        const staged = [join(workspace, "staged", "one"), join(workspace, "staged", "two")];
        await Promise.all(staged.map(async (path, index) => {
          await rawWorkflowPackage(join(path, ".."), basename(path), workflowSource("release"));
          await writeFile(join(path, "writer"), String(index));
        }));
        const prepared = await Promise.all([
          prepareWorkflowCatalogCommit(workspace, "project", "release"),
          prepareWorkflowCatalogCommit(workspace, "project", "release"),
        ]);
        const publications = prepared.map((result, index) => {
          if (result.isErr()) throw new Error("Both writers must prepare before publication starts.");
          return result.value.commit(staged[index]!);
        });

        const committed = await Promise.all(publications);
        const winner = committed.findIndex(result => result.isOk());
        const loser = committed.findIndex(result => result.isErr());

        expect(committed.map(result => result.isOk() ? "success" : result.error.type).sort()).toEqual(["collision", "success"]);
        expect(await readFile(join(workspace, ".acpus", "workflows", "release", "writer"), "utf8")).toBe(String(winner));
        await expect(readFile(join(staged[winner]!, "workflow.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(staged[loser]!, "workflow.ts"), "utf8")).resolves.toContain('name: "release"');
      });
    });
  });
});

async function workflowPackage(root: string, name: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workflow.ts"), workflowSource(name));
}

async function ignoredIndexWorkflowFilePackage(root: string, name: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.workflow.ts"), workflowSource(name));
}

async function rawWorkflowPackage(root: string, name: string, source: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workflow.ts"), source);
}

function workflowSource(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    "",
    "export default defineWorkflow({",
    `  name: ${JSON.stringify(name)},`,
    "}).build(() => ({ ok: true }));",
    "",
  ].join("\n");
}

async function testHome(name: string): Promise<string> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${name}-`));
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}
