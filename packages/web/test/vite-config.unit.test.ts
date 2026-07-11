import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web Vite chunking", () => {
  const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

  it("splits large third-party UI dependencies into explicit vendor chunks", () => {
    expect(source).toContain("rolldownOptions");
    expect(source).toContain("codeSplitting");
    expect(source).toContain("groups: [{ name: packageChunk }]");
    expect(source).toContain('return "vendor-react"');
    expect(source).toContain('return "vendor-radix"');
    expect(source).toContain('return "vendor-json-view"');
    expect(source).toContain('return "vendor-icons"');
    expect(source).toContain('return "vendor-query"');
    expect(source).toContain('return "vendor"');
  });

  it("gives Vite sole ownership of the client output directory", () => {
    expect(source).toContain('outDir: "../../dist/client"');
    expect(source).toContain("emptyOutDir: true");
  });

  it("does not proxy the client api.ts module as a backend request", () => {
    expect(source).toContain('"/api/": "http://localhost:4517"');
    expect(source).not.toContain('"/api": "http://localhost:4517"');
  });
});
