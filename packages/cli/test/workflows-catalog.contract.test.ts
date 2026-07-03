import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { repoRoot } from "./support/cli-runner.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("workflow catalog CLI contracts", () => {
  it("lists and shows catalog entries with stable JSON fields", async () => {
    await withTestWorkspace("catalog-cli", async workspace => {
      await withTestHome("catalog-cli-home", async home => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "release");
        await workflowPackage(join(workspace, ".acpus", "workflows"), "poison", "throw new Error('list/show must not import workflow modules');\n");
        await workflowPackage(join(home, ".acpus", "workflows"), "deploy");

        const listed = await runJson(workspace, ["workflows", "list", "--json"]);
        expect(listed.exitCode).toBe(0);
        expect(listed.json).toMatchObject({
          ok: true,
          phase: "inspect",
          catalogEntries: [
            { scope: "global", name: "deploy", status: "available", requiresScope: false },
            { scope: "project", name: "poison", status: "available", requiresScope: false },
            { scope: "project", name: "release", status: "available", requiresScope: false },
          ],
        });
        expect(listed.json.catalogEntries[0].packagePath).toBe(join(home, ".acpus", "workflows", "deploy"));
        expect(listed.json.catalogEntries[2].entryPath).toBe(join(workspace, ".acpus", "workflows", "release", "workflow.ts"));

        const shown = await runJson(workspace, ["workflows", "show", "release", "--json"]);
        expect(shown.exitCode).toBe(0);
        expect(shown.json).toMatchObject({
          ok: true,
          phase: "inspect",
          catalog: {
            scope: "project",
            name: "release",
            packagePath: join(workspace, ".acpus", "workflows", "release"),
            entryPath: join(workspace, ".acpus", "workflows", "release", "workflow.ts"),
          },
        });

        const poison = await runJson(workspace, ["workflows", "show", "poison", "--json"]);
        expect(poison.exitCode).toBe(0);
        expect(poison.json).toMatchObject({
          ok: true,
          catalog: { scope: "project", name: "poison" },
        });
      });
    });
  });

  it("reports catalog scope and lookup failures with stable phases", async () => {
    await withTestWorkspace("catalog-cli-errors", async workspace => {
      await withTestHome("catalog-cli-errors-home", async home => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "shared");
        await workflowPackage(join(home, ".acpus", "workflows"), "shared");

        const scoped = await runJson(workspace, ["workflows", "list", "--project", "--json"]);
        expect(scoped.exitCode).toBe(0);
        expect(scoped.json.catalogEntries).toMatchObject([
          { scope: "project", name: "shared", status: "available", requiresScope: true },
        ]);

        const ambiguous = await runJson(workspace, ["workflows", "show", "shared", "--json"]);
        expect(ambiguous.exitCode).toBe(2);
        expect(ambiguous.json).toMatchObject({
          ok: false,
          phase: "usage",
        });
        expect(ambiguous.json.message).toContain("Pass --project or --global");

        const missing = await runJson(workspace, ["workflows", "show", "missing", "--project", "--json"]);
        expect(missing.exitCode).toBe(1);
        expect(missing.json).toMatchObject({
          ok: false,
          phase: "inspect",
        });

        const invalid = await runJson(workspace, ["workflows", "show", "not_valid", "--json"]);
        expect(invalid.exitCode).toBe(2);
        expect(invalid.json).toMatchObject({
          ok: false,
          phase: "usage",
        });

        const scopeConflict = await runJson(workspace, ["workflows", "list", "--project", "--global", "--json"]);
        expect(scopeConflict.exitCode).toBe(2);
        expect(scopeConflict.json).toMatchObject({
          ok: false,
          phase: "usage",
        });
      });
    });
  });
});

async function runJson(workspace: string, args: string[]): Promise<{ exitCode: number; json: any }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  expect(stderr.text).toBe("");
  return { exitCode, json: JSON.parse(stdout.text) };
}

async function workflowPackage(root: string, name: string, source?: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workflow.ts"), source ?? [
    'import { defineWorkflow } from "acpus/core";',
    "",
    `export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({ ok: true }));`,
    "",
  ].join("\n"));
}

async function withTestHome<T>(name: string, fn: (home: string) => Promise<T>): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, `${name}-`));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}
