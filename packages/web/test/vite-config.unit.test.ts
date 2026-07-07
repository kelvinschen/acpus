import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web Vite chunking", () => {
  const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

  it("splits large third-party UI dependencies into explicit vendor chunks", () => {
    expect(source).toContain("manualChunks: packageChunk");
    expect(source).toContain('return "vendor-react"');
    expect(source).toContain('return "vendor-radix"');
    expect(source).toContain('return "vendor-json-view"');
    expect(source).toContain('return "vendor-icons"');
    expect(source).toContain('return "vendor-query"');
    expect(source).toContain('return "vendor"');
  });
});
