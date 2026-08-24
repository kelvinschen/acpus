import { createServer, type RequestListener, type Server } from "node:http";
import { access, chmod, link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { create as createTar } from "tar";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  globalImportRoot,
  importDirect,
  projectImportRoot,
  readNames,
  runImportText,
  withTestHome,
  workflowSource,
} from "./support/workflow-import.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("workflow import contracts", () => {
  it("adapts local snapshot imports to exact CLI output without executing or persisting provenance", async () => {
    await withPlainTestWorkspace("workflow-import-cli", async workspace => {
      await withTestHome("workflow-import-cli-home", async () => {
        const marker = join(workspace, "top-level-ran");
        const source = join(workspace, "source.ts");
        const original = executableWorkflowSource("static-import", marker);
        await writeFile(source, original);

        const imported = await runImportText(workspace, ["workflow", "import", source]);
        expect(imported.exitCode).toBe(0);
        expect(imported.stdout).toBe([
          "Workflow imported.",
          "Catalog workflow: static-import",
          "Catalog scope: project",
          "Catalog status: available",
          `Catalog package: ${join(workspace, ".acpus", "workflows", "static-import")}`,
          `Catalog entry: ${join(workspace, ".acpus", "workflows", "static-import", "workflow.ts")}`,
          "Checked: no",
          "",
        ].join("\n"));
        expect(imported.stdout).not.toContain(source);
        expect(imported.stderr).toBe("");
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        const committedEntry = join(workspace, ".acpus", "workflows", "static-import", "workflow.ts");
        expect(await readFile(committedEntry, "utf8")).toBe(original);
        await writeFile(source, workflowSource("changed-source"));
        expect(await readFile(committedEntry, "utf8")).toBe(original);
        expect(await readNames(join(workspace, ".acpus", "workflows", "static-import"))).toEqual(["workflow.ts"]);

        const collision = await runImportText(workspace, ["workflow", "import", committedEntry]);
        expect(collision.exitCode).toBe(1);
        expect(collision.stdout).toBe("");
        expect(collision.stderr).toContain("Error code: IMPORT_COLLISION");
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);

        const unsupported = join(workspace, "source.txt");
        await writeFile(unsupported, workflowSource("unsupported"));
        expect((await runImportText(workspace, ["workflow", "import", unsupported]))).toMatchObject({
          exitCode: 2,
          stdout: "",
          stderr: expect.stringContaining("Workflow import source must be a directory or end in"),
        });
        expect((await runImportText(workspace, ["workflow", "import", unsupported, "--project", "--global"]))).toMatchObject({
          exitCode: 2,
          stdout: "",
          stderr: expect.stringContaining("--project and --global are mutually exclusive."),
        });
      });
    });
  });

  it("imports directory, ZIP, and TGZ packages through the module seam", async () => {
    await withPlainTestWorkspace("workflow-import-packages", async workspace => {
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
    await withPlainTestWorkspace("workflow-import-http", async workspace => {
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

  it("rejects hard links and invalid package layouts without staging residue", async () => {
    await withPlainTestWorkspace("workflow-import-local-safety", async workspace => {
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
    await withPlainTestWorkspace("workflow-import-archive-safety", async workspace => {
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

function expectOk(
  result: Awaited<ReturnType<typeof importDirect>>,
  name: string,
  scope: "project" | "global",
  checked = false,
): void {
  if (Result.isFailure(result)) throw new Error(`Expected import success, received ${JSON.stringify(result.failure)}`);
  expect(result.success).toMatchObject({ checked, catalog: { name, scope, status: "available" } });
}

function expectImportFailure(result: Awaited<ReturnType<typeof importDirect>>, errorCode: string): void {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ type: "import", errorCode });
}

function executableWorkflowSource(name: string, marker: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "executed");`,
    workflowSource(name),
  ].join("\n");
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
