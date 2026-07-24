import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { repoRoot } from "./support/cli-runner.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

const promptMocks = vi.hoisted(() => ({
  cancel: Symbol("cancel"),
  select: vi.fn<(options: { options: Array<{ value: number; label?: string; hint?: string; disabled?: boolean }> }) => Promise<number | symbol>>(),
}));

vi.mock("@clack/prompts", async importOriginal => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  select: promptMocks.select,
  isCancel: (value: unknown) => value === promptMocks.cancel,
}));

describe("workflow catalog CLI contracts", () => {
  beforeEach(() => {
    promptMocks.select.mockReset();
  });

  it("queries the catalog collection or one named entry with stable JSON fields", async () => {
    await withPlainTestWorkspace("catalog-cli", async workspace => {
      await withTestHome("catalog-cli-home", async home => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "release");
        await workflowPackage(join(workspace, ".acpus", "workflows"), "poison", [
          "throw new Error('catalog queries must not import workflow modules');",
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "poison" }).build(() => ({ ok: true }));',
          "",
        ].join("\n"));
        await workflowPackage(join(home, ".acpus", "workflows"), "deploy");

        const listed = await runJson(workspace, ["workflow", "catalog", "--json"]);
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
        expect(listed.json).not.toHaveProperty("message");

        const textList = await runText(workspace, ["workflow", "catalog"]);
        expect(textList.stdout).toBe([
          "global   available  deploy",
          "project  available  poison",
          "project  available  release",
          "",
        ].join("\n"));
        expect(textList.stdout).not.toContain(workspace);
        expect(textList.stdout).not.toContain(home);

        const shown = await runJson(workspace, ["workflow", "catalog", "release", "--json"]);
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
        expect(shown.json).not.toHaveProperty("message");

        const plainEntry = [
          "Catalog: project/release",
          "Status: available",
          `Package: ${join(workspace, ".acpus", "workflows", "release")}`,
          `Entry: ${join(workspace, ".acpus", "workflows", "release", "workflow.ts")}`,
          "",
        ].join("\n");
        const textEntry = await runText(workspace, ["workflow", "catalog", "release"]);
        expect(textEntry.stdout).toBe(plainEntry);

        const coloredStdout = new TtyCaptureStream();
        expect(await withNoColor(undefined, () => runCli(["workflow", "catalog", "release"], {
          cwd: workspace,
          stdout: coloredStdout,
          stderr: new TtyCaptureStream(),
        }))).toBe(0);
        expect(coloredStdout.text).toBe([
          "\u001b[36mCatalog:\u001b[0m \u001b[1mproject/release\u001b[0m",
          "\u001b[36mStatus:\u001b[0m \u001b[32mavailable\u001b[0m",
          `\u001b[36mPackage:\u001b[0m ${join(workspace, ".acpus", "workflows", "release")}`,
          `\u001b[36mEntry:\u001b[0m ${join(workspace, ".acpus", "workflows", "release", "workflow.ts")}`,
          "",
        ].join("\n"));

        const noColorStdout = new TtyCaptureStream();
        expect(await withNoColor("1", () => runCli(["workflow", "catalog", "release"], {
          cwd: workspace,
          stdout: noColorStdout,
          stderr: new TtyCaptureStream(),
        }))).toBe(0);
        expect(noColorStdout.text).toBe(plainEntry);

        const poison = await runJson(workspace, ["workflow", "catalog", "poison", "--json"]);
        expect(poison.exitCode).toBe(0);
        expect(poison.json).toMatchObject({
          ok: true,
          catalog: { scope: "project", name: "poison" },
        });
      });
    });
  });

  it("reports catalog scope and lookup failures with stable phases", async () => {
    await withPlainTestWorkspace("catalog-cli-errors", async workspace => {
      await withTestHome("catalog-cli-errors-home", async home => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "shared");
        await workflowPackage(join(home, ".acpus", "workflows"), "shared");

        const scoped = await runJson(workspace, ["workflow", "catalog", "--project", "--json"]);
        expect(scoped.exitCode).toBe(0);
        expect(scoped.json.catalogEntries).toMatchObject([
          { scope: "project", name: "shared", status: "available", requiresScope: true },
        ]);

        const ambiguous = await runJson(workspace, ["workflow", "catalog", "shared", "--json"]);
        expect(ambiguous.exitCode).toBe(2);
        expect(ambiguous.json).toMatchObject({
          ok: false,
          phase: "usage",
        });
        expect(ambiguous.json.message).toContain("Pass --project or --global");

        const missing = await runJson(workspace, ["workflow", "catalog", "missing", "--project", "--json"]);
        expect(missing.exitCode).toBe(1);
        expect(missing.json).toMatchObject({
          ok: false,
          phase: "inspect",
        });

        const invalid = await runJson(workspace, ["workflow", "catalog", "not_valid", "--json"]);
        expect(invalid.exitCode).toBe(2);
        expect(invalid.json).toMatchObject({
          ok: false,
          phase: "usage",
        });

        const scopeConflict = await runJson(workspace, ["workflow", "catalog", "--project", "--global", "--json"]);
        expect(scopeConflict.exitCode).toBe(2);
        expect(scopeConflict.json).toMatchObject({
          ok: false,
          phase: "usage",
        });
      });
    });
  });

  it("lists invalid packages after available entries and excludes them from lookup", async () => {
    await withPlainTestWorkspace("catalog-cli-invalid", async workspace => {
      await withTestHome("catalog-cli-invalid-home", async () => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "available");
        await workflowPackage(join(workspace, ".acpus", "workflows"), "wrong-directory", [
          'import { defineWorkflow } from "acpus/core";',
          'export default defineWorkflow({ name: "authored-name" }).build(() => ({ ok: true }));',
          "",
        ].join("\n"));
        await mkdir(join(workspace, ".acpus", "workflows", "missing-entry"), { recursive: true });

        const listed = await runJson(workspace, ["workflow", "catalog", "--project", "--json"]);
        expect(listed.exitCode).toBe(0);
        expect(listed.json.catalogEntries).toMatchObject([
          { status: "available", name: "available" },
          { status: "invalid", errorCode: "CATALOG_ENTRY_MISSING", requiresScope: false },
          { status: "invalid", name: "authored-name", errorCode: "CATALOG_NAME_MISMATCH", requiresScope: false },
        ]);

        const text = await runText(workspace, ["workflow", "catalog", "--project"]);
        expect(text.stdout).toContain("missing-entry");
        expect(text.stdout).toContain("CATALOG_ENTRY_MISSING");
        expect(text.stdout).not.toContain(workspace);

        const invalid = await runJson(workspace, ["workflow", "catalog", "authored-name", "--project", "--json"]);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.json).toMatchObject({ ok: false, phase: "inspect", errorCode: "CATALOG_NAME_MISMATCH" });
      });
    });
  });

  it("selects a duplicate-scope workflow in a TTY and reuses scoped named lookup", async () => {
    await withPlainTestWorkspace("catalog-cli-picker", async workspace => {
      await withTestHome("catalog-cli-picker-home", async home => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "shared");
        await workflowPackage(join(home, ".acpus", "workflows"), "shared");
        await mkdir(join(workspace, ".acpus", "workflows", "broken"), { recursive: true });
        promptMocks.select.mockImplementationOnce(async ({ options }) => {
          const visible = options.map(option => `${option.label} ${option.hint} ${option.disabled ?? false}`).join("\n");
          expect(visible).toBe([
            "shared (project) scope required false",
            "shared (global) scope required false",
            "broken project · CATALOG_ENTRY_MISSING true",
          ].join("\n"));
          expect(visible).not.toContain(workspace);
          expect(visible).not.toContain(home);
          return options.find(option => option.label === "shared (global)")!.value;
        });
        const stdin = new TtyInput();
        const stdout = new TtyCaptureStream();
        const stderr = new TtyCaptureStream();

        const exitCode = await withNoColor(undefined, () => runCli(
          ["workflow", "catalog"],
          { cwd: workspace, stdin, stdout, stderr },
        ));

        expect(exitCode).toBe(0);
        expect(promptMocks.select).toHaveBeenCalledOnce();
        expect(promptMocks.select.mock.calls[0]![0]).toMatchObject({ output: stderr });
        expect(stdout.text).toContain("\u001b[36mCatalog:\u001b[0m");
        expect(stripVTControlCharacters(stdout.text)).toBe([
          "Catalog: global/shared",
          "Status: available (requires --project or --global when unscoped)",
          `Package: ${join(home, ".acpus", "workflows", "shared")}`,
          `Entry: ${join(home, ".acpus", "workflows", "shared", "workflow.ts")}`,
          "",
        ].join("\n"));
      });
    });
  });

  it("does not prompt for JSON or when no available workflow can be selected", async () => {
    await withPlainTestWorkspace("catalog-cli-picker-fallback", async workspace => {
      await withTestHome("catalog-cli-picker-fallback-home", async () => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "available");
        const jsonStdout = new TtyCaptureStream();
        expect(await runCli(["workflow", "catalog", "--json"], {
          cwd: workspace,
          stdin: new TtyInput(),
          stdout: jsonStdout,
          stderr: new TtyCaptureStream(),
        })).toBe(0);
        expect(promptMocks.select).not.toHaveBeenCalled();
        expect(JSON.parse(jsonStdout.text).catalogEntries).toHaveLength(1);

        await rm(join(workspace, ".acpus", "workflows", "available"), { recursive: true, force: true });
        await mkdir(join(workspace, ".acpus", "workflows", "broken"), { recursive: true });
        const textStdout = new TtyCaptureStream();
        expect(await runCli(["workflow", "catalog"], {
          cwd: workspace,
          stdin: new TtyInput(),
          stdout: textStdout,
          stderr: new TtyCaptureStream(),
        })).toBe(0);
        expect(promptMocks.select).not.toHaveBeenCalled();
        expect(textStdout.text).toContain("broken");
        expect(textStdout.text).toContain("CATALOG_ENTRY_MISSING");
        expect(textStdout.text).not.toContain(workspace);
      });
    });
  });

  it("maps interactive catalog cancellation to usage", async () => {
    await withPlainTestWorkspace("catalog-cli-picker-cancel", async workspace => {
      await withTestHome("catalog-cli-picker-cancel-home", async () => {
        await workflowPackage(join(workspace, ".acpus", "workflows"), "available");
        promptMocks.select.mockResolvedValueOnce(promptMocks.cancel);
        const stdout = new TtyCaptureStream();
        const stderr = new TtyCaptureStream();

        expect(await runCli(["workflow", "catalog"], {
          cwd: workspace,
          stdin: new TtyInput(),
          stdout,
          stderr,
        })).toBe(2);
        expect(stdout.text).toBe("");
        expect(stderr.text).toContain("Workflow selection cancelled.");
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

async function runText(workspace: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
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

async function withNoColor<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NO_COLOR;
  if (value === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
}

class TtyInput extends Readable {
  readonly isTTY = true;

  setRawMode(_mode: boolean): this {
    return this;
  }

  override _read(): void {}
}

class TtyCaptureStream extends CaptureStream {
  readonly isTTY = true;
}
