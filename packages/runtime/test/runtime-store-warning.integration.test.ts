import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

describe("runtime SQLite warning", () => {
  afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it("suppresses only the SQLite experimental warning during store initialization", async () => {
    const [workspace, home] = await Promise.all([
      mkdtemp(join(tmpdir(), "acpus-runtime-sqlite-warning-")),
      mkdtemp(join(tmpdir(), "acpus-runtime-sqlite-warning-home-")),
    ]);
    temporaryPaths.push(workspace, home);
    const storeModule = pathToFileURL(join(import.meta.dirname, "../src/store/store.ts")).href;
    const script = `
      import { openRuntimeStore } from ${JSON.stringify(storeModule)};
      const emitWarning = process.emitWarning;
      const store = await openRuntimeStore(process.argv[1]);
      store.close();
      if (process.emitWarning !== emitWarning) throw new Error("process.emitWarning was not restored");
      process.emitWarning("Acpus warning sentinel", "ExperimentalWarning");
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.NODE_NO_WARNINGS;
    delete env.NODE_OPTIONS;

    const result = await execFileAsync(process.execPath, [
      "--conditions=development",
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      script,
      workspace,
    ], { env });

    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("SQLite is an experimental feature and might change at any time");
    expect(result.stderr).toContain("ExperimentalWarning: Acpus warning sentinel");
  });
});
