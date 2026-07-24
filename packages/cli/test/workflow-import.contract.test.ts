import { createServer, type RequestListener, type Server } from "node:http";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { create as createTar } from "tar";
import { describe, expect, it } from "vitest";
import { importWorkflowPackage } from "../src/workflow-import.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { repoRoot } from "./support/cli-runner.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("workflow import contracts", () => {
  it("adapts local snapshot imports to exact CLI output without executing or persisting provenance", async () => {
    await withTestWorkspace("workflow-import-cli", async workspace => {
      await withTestHome("workflow-import-cli-home", async () => {
        const marker = join(workspace, "top-level-ran");
        const source = join(workspace, "source.ts");
        const original = executableWorkflowSource("static-import", marker);
        await writeFile(source, original);

        const imported = await runJson(workspace, ["workflow", "import", source, "--json"]);
        expect(imported.exitCode).toBe(0);
        expect(Object.keys(imported.json).sort()).toEqual(["catalog", "checked", "message", "ok", "phase", "schemaVersion"]);
        expect(imported.json).toMatchObject({
          ok: true,
          phase: "import",
          checked: false,
          catalog: { scope: "project", name: "static-import", status: "available", requiresScope: false },
        });
        expect(imported.text).not.toContain(source);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        const committedEntry = join(workspace, ".acpus", "workflows", "static-import", "workflow.ts");
        expect(await readFile(committedEntry, "utf8")).toBe(original);
        await writeFile(source, workflowSource("changed-source"));
        expect(await readFile(committedEntry, "utf8")).toBe(original);
        expect(await readNames(join(workspace, ".acpus", "workflows", "static-import"))).toEqual(["workflow.ts"]);

        const textSource = join(workspace, "text-source.ts");
        await writeFile(textSource, workflowSource("text-import"));
        const text = await runText(workspace, ["workflow", "import", textSource]);
        expect(text).toEqual({
          exitCode: 0,
          stdout: [
            "Workflow imported.",
            "Catalog: project/text-import",
            "Catalog status: available",
            `Catalog package: ${join(workspace, ".acpus", "workflows", "text-import")}`,
            `Catalog entry: ${join(workspace, ".acpus", "workflows", "text-import", "workflow.ts")}`,
            "Checked: no",
            "",
          ].join("\n"),
          stderr: "",
        });

        const collision = await runJson(workspace, ["workflow", "import", committedEntry, "--json"]);
        expect(collision.exitCode).toBe(1);
        expect(collision.json).toMatchObject({ ok: false, phase: "import", errorCode: "IMPORT_COLLISION" });
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);

        const unsupported = join(workspace, "source.txt");
        await writeFile(unsupported, workflowSource("unsupported"));
        expect((await runJson(workspace, ["workflow", "import", unsupported, "--json"]))).toMatchObject({
          exitCode: 2,
          json: { ok: false, phase: "usage" },
        });
        expect((await runJson(workspace, ["workflow", "import", unsupported, "--project", "--global", "--json"]))).toMatchObject({
          exitCode: 2,
          json: { ok: false, phase: "usage" },
        });
      });
    });
  });

  it("imports directory, ZIP, and TGZ packages through the module seam", async () => {
    await withTestWorkspace("workflow-import-packages", async workspace => {
      await withTestHome("workflow-import-packages-home", async home => {
        const directory = join(workspace, "directory-source");
        await writePackage(join(directory, "wrapper"), "directory-import", {
          "README.md": "directory",
          "package.json": JSON.stringify({ dependencies: { uninstalled: "1.0.0" } }),
        });
        const directoryImport = await importDirect(workspace, directory);
        expectOk(directoryImport, "directory-import", "project");

        const zipPath = join(workspace, "source.ZIP");
        await writeZip(zipPath, [
          ["wrapper/workflow.ts", workflowSource("zip-import")],
          ["wrapper/bin/run.sh", "#!/bin/sh\n", 0o104755],
        ]);
        const zipImport = await importDirect(workspace, zipPath);
        expectOk(zipImport, "zip-import", "project");

        const tarSource = join(workspace, "tar-source");
        await writePackage(join(tarSource, "package"), "tar-import", { "data/value.txt": "tar" });
        const tarPath = join(workspace, "source.tGz");
        createTar({ cwd: tarSource, file: tarPath, gzip: true, sync: true }, ["package"]);
        await mkdir(join(home, ".acpus", "tmp"), { recursive: true });
        if (process.platform !== "win32") {
          await chmod(join(home, ".acpus"), 0o777);
          await chmod(join(home, ".acpus", "tmp"), 0o755);
        }
        const tarImport = await importDirect(workspace, tarPath, { scope: "global" });
        expectOk(tarImport, "tar-import", "global");

        expect(await readNames(join(workspace, ".acpus", "workflows", "directory-import"))).toEqual(["README.md", "package.json", "workflow.ts"]);
        await expect(access(join(workspace, ".acpus", "workflows", "directory-import", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readNames(join(workspace, ".acpus", "workflows", "zip-import", "bin"))).toEqual(["run.sh"]);
        expect((await stat(join(workspace, ".acpus", "workflows", "zip-import", "bin", "run.sh"))).mode & 0o7777).toBe(0o755);
        expect(await readNames(join(home, ".acpus", "workflows", "tar-import", "data"))).toEqual(["value.txt"]);
        if (process.platform !== "win32") {
          for (const directory of [
            join(home, ".acpus"),
            join(home, ".acpus", "tmp"),
            globalImportRoot(home),
            join(home, ".acpus", "workflows"),
            join(home, ".acpus", "workflows", "tar-import"),
          ]) {
            expect((await stat(directory)).mode & 0o777).toBe(0o700);
          }
        }
      });
    });
  });

  it("downloads real HTTP redirects, enforces the redirect limit, and accepts HTTPS responses", async () => {
    await withTestWorkspace("workflow-import-http", async workspace => {
      await withTestHome("workflow-import-http-home", async () => {
        const server = await startServer((request, response) => {
          if (request.url?.startsWith("/redirect.ts")) {
            response.writeHead(302, { location: "/payload" }).end();
            return;
          }
          if (request.url?.startsWith("/loop.ts")) {
            response.writeHead(302, { location: "/loop.ts" }).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/octet-stream" }).end(workflowSource("remote-import"));
        });
        try {
          const origin = serverOrigin(server);
          const imported = await importDirect(workspace, `${origin}/redirect.ts?secret=do-not-persist`);
          expectOk(imported, "remote-import", "project");
          expect(await readNames(join(workspace, ".acpus", "workflows", "remote-import"))).toEqual(["workflow.ts"]);
          expect(await readFile(join(workspace, ".acpus", "workflows", "remote-import", "workflow.ts"), "utf8")).not.toContain("secret");

          const redirected = await importDirect(workspace, `${origin}/loop.ts`);
          expectImportFailure(redirected, "IMPORT_DOWNLOAD_FAILED");
        } finally {
          await closeServer(server);
        }

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(workflowSource("https-import"), { status: 200 });
        try {
          const imported = await importDirect(workspace, "https://example.invalid/source.ts");
          expectOk(imported, "https-import", "project");
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });
  });

  it("checks a global import in current-workspace dependency context and preserves exact preparation failures", async () => {
    await withTestWorkspace("workflow-import-check", async workspace => {
      await withTestHome("workflow-import-check-home", async home => {
        await installWorkspaceOnlyDependency(workspace);
        const checkedSource = join(workspace, "workspace-checked.ts");
        await writeFile(checkedSource, workspaceDependencyWorkflowSource("workspace-checked"));

        const checked = await importDirect(workspace, checkedSource, { scope: "global", check: true });
        expectOk(checked, "workspace-checked", "global", true);
        await expect(access(join(home, ".acpus", "workflows", "workspace-checked", "workflow.ts"))).resolves.toBeUndefined();
        expect(await readNames(globalImportRoot(home))).toEqual([]);
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);

        const failingSource = join(workspace, "failing.ts");
        await writeFile(failingSource, ["throw new Error('top-level import failure');", workflowSource("failed-check")].join("\n"));
        const failed = await importDirect(workspace, failingSource, { check: true });
        expect(failed.isErr()).toBe(true);
        if (failed.isErr()) {
          expect(failed.error.type).toBe("preparation");
          if (failed.error.type === "preparation") {
            expect(failed.error.failure.phase).toBe("compile");
            expect(failed.error.failure.message).toContain("top-level import failure");
          }
        }
        await expect(access(join(workspace, ".acpus", "workflows", "failed-check"))).rejects.toMatchObject({ code: "ENOENT" });

        const cliFailure = await runJson(workspace, ["workflow", "import", failingSource, "--check", "--json"]);
        expect(cliFailure).toMatchObject({ exitCode: 1, json: { ok: false, phase: "compile" } });
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);
      });
    });
  });

  it("rejects hard links and invalid package layouts without staging residue", async () => {
    await withTestWorkspace("workflow-import-local-safety", async workspace => {
      await withTestHome("workflow-import-local-safety-home", async () => {
        const original = join(workspace, "original.ts");
        const hardlinkSource = join(workspace, "hardlink.ts");
        await writeFile(original, workflowSource("hardlink-source"));
        await link(original, hardlinkSource);
        expectImportFailure(await importDirect(workspace, hardlinkSource), "IMPORT_SOURCE_INVALID");

        const packageRoot = join(workspace, "hardlink-package");
        await writePackage(packageRoot, "hardlink-package", { "data.txt": "linked" });
        await link(join(packageRoot, "data.txt"), join(packageRoot, "data-copy.txt"));
        expectImportFailure(await importDirect(workspace, packageRoot), "IMPORT_PACKAGE_INVALID");

        const wrappers = join(workspace, "two-wrappers");
        await writePackage(join(wrappers, "one"), "wrapper-one");
        await writePackage(join(wrappers, "two"), "wrapper-two");
        expectImportFailure(await importDirect(workspace, wrappers), "IMPORT_PACKAGE_INVALID");
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);
      });
    });
  });

  it("rejects unsafe ZIP and TAR entries before catalog commit", async () => {
    await withTestWorkspace("workflow-import-archive-safety", async workspace => {
      await withTestHome("workflow-import-archive-safety-home", async () => {
        for (const [filename, entries] of [
          ["case.zip", [["wrapper/workflow.ts", workflowSource("case")], ["wrapper/WORKFLOW.ts", workflowSource("collision")]]],
          ["traversal.zip", [["../outside", "escape"]]],
          ["absolute.zip", [["/absolute", "escape"]]],
          ["unicode.zip", [["e\u0301.txt", "one"], ["é.txt", "two"]]],
          ["special.zip", [["fifo", "", 0o010644]]],
        ] satisfies Array<[string, Array<[string, string, number?]>]>) {
          const archive = join(workspace, filename);
          await writeZip(archive, entries);
          expectImportFailure(await importDirect(workspace, archive), "IMPORT_ARCHIVE_INVALID");
        }

        const tarSource = join(workspace, "unsafe-tar-source");
        await writePackage(join(tarSource, "package"), "unsafe-tar");
        await symlink("workflow.ts", join(tarSource, "package", "workflow-link.ts"));
        const symlinkTar = join(workspace, "symlink.tar.gz");
        createTar({ cwd: tarSource, file: symlinkTar, gzip: true, sync: true }, ["package"]);
        expectImportFailure(await importDirect(workspace, symlinkTar), "IMPORT_ARCHIVE_INVALID");

        await rm(join(tarSource, "package", "workflow-link.ts"));
        const duplicateTar = join(workspace, "duplicate.tar.gz");
        createTar({ cwd: tarSource, file: duplicateTar, gzip: true, sync: true }, ["package/workflow.ts", "package/workflow.ts"]);
        expectImportFailure(await importDirect(workspace, duplicateTar), "IMPORT_ARCHIVE_INVALID");

        await link(join(tarSource, "package", "workflow.ts"), join(tarSource, "package", "workflow-hardlink.ts"));
        const hardlinkTar = join(workspace, "hardlink.tar.gz");
        // Fixture creation is synchronous because only archive import is under test.
        createTar({ cwd: tarSource, file: hardlinkTar, gzip: true, sync: true }, ["package"]);
        expectImportFailure(await importDirect(workspace, hardlinkTar), "IMPORT_ARCHIVE_INVALID");
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);
      });
    });
  });
});

async function importDirect(
  workspace: string,
  source: string,
  options: { scope?: "project" | "global"; check?: boolean } = {},
) {
  return importWorkflowPackage({
    cwd: workspace,
    source,
    scope: options.scope ?? "project",
    check: options.check ?? false,
  });
}

function expectOk(
  result: Awaited<ReturnType<typeof importDirect>>,
  name: string,
  scope: "project" | "global",
  checked = false,
): void {
  if (result.isErr()) throw new Error(`Expected import success, received ${JSON.stringify(result.error)}`);
  expect(result.value).toMatchObject({ checked, catalog: { name, scope, status: "available" } });
}

function expectImportFailure(result: Awaited<ReturnType<typeof importDirect>>, errorCode: string): void {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error).toMatchObject({ type: "import", errorCode });
}

async function runJson(workspace: string, args: string[]): Promise<{ exitCode: number; json: any; text: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  expect(stderr.text).toBe("");
  return { exitCode, json: JSON.parse(stdout.text), text: stdout.text };
}

async function runText(workspace: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function workflowSource(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    `export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({ ok: true }));`,
    "",
  ].join("\n");
}

function executableWorkflowSource(name: string, marker: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "executed");`,
    workflowSource(name),
  ].join("\n");
}

function workspaceDependencyWorkflowSource(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    'import { workspaceValue } from "workspace-only";',
    `export default defineWorkflow({ name: ${JSON.stringify(name)}, description: workspaceValue }).build(() => ({ ok: true }));`,
    "",
  ].join("\n");
}

async function installWorkspaceOnlyDependency(workspace: string): Promise<void> {
  const nodeModules = join(workspace, "node_modules");
  await rm(nodeModules);
  await mkdir(join(nodeModules, "workspace-only"), { recursive: true });
  await symlink(join(repoRoot, "packages", "cli"), join(nodeModules, "acpus"), "dir");
  await symlink(join(repoRoot, "node_modules", "@types"), join(nodeModules, "@types"), "dir");
  await writeFile(join(nodeModules, "workspace-only", "package.json"), JSON.stringify({
    name: "workspace-only",
    type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  }));
  await writeFile(join(nodeModules, "workspace-only", "index.d.ts"), 'export declare const workspaceValue: "from-workspace";\n');
  await writeFile(join(nodeModules, "workspace-only", "index.js"), 'export const workspaceValue = "from-workspace";\n');
}

async function writePackage(root: string, name: string, files: Record<string, string> = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "workflow.ts"), workflowSource(name));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
}

async function writeZip(path: string, files: Array<[string, string, number?]>): Promise<void> {
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output);
  for (const [name, contents, mode] of files) await writer.add(name, new TextReader(contents), { unixMode: mode ?? 0o100644 });
  await writeFile(path, await writer.close());
}

async function readNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function projectImportRoot(workspace: string): string {
  return join(workspace, ".acpus", "tmp");
}

function globalImportRoot(home: string): string {
  return join(home, ".acpus", "tmp", "workflow-imports");
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

async function startServer(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
