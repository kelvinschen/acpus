import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web build scripts", () => {
  const buildSource = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const staticVizSource = readFileSync(new URL("../scripts/build-static-viz.mjs", import.meta.url), "utf8");

  it("starts the client and static viz builds together, then waits for server compilation", () => {
    expect(buildSource).toContain('const clientBuild = run(bin("vite")');
    expect(buildSource).toContain('const serverBuild = run(process.execPath, ["scripts/build-static-viz.mjs"])');
    expect(buildSource).toContain('.then(() => run(bin("tsc"), ["-b", "tsconfig.build.json"]))');
    expect(buildSource).toContain("Promise.allSettled([clientBuild, serverBuild])");
    expect(buildSource).not.toContain('"--noCheck"');
  });

  it("always removes the temporary static viz output", () => {
    expect(staticVizSource).toContain("} finally {");
    expect(staticVizSource.match(/await rm\(outDir, \{ recursive: true, force: true \}\);/g)).toHaveLength(2);
    expect(staticVizSource).toContain("rolldownOptions");
    expect(staticVizSource).not.toContain("rollupOptions");
  });
});
