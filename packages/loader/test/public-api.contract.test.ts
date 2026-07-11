import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("loader public API", () => {
  it("exports only the internal loader boundary", () => {
    expect(Object.keys(api).sort()).toEqual([
      "importAuthoringModule",
      "officialAuthoringTypeScriptPaths",
    ]);
  });

  it("packs the built loader entrypoint", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot });
    const files = (JSON.parse(stdout) as [{ files: { path: string }[] }])[0].files.map(file => file.path);

    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/index.d.ts");
  });
});
