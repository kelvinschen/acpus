import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

describe("package entry boundaries", () => {
  it("keeps the normal TUI entrypoint decoupled from served-bridge dependencies", () => {
    const index = readFileSync(`${sourceRoot}index.tsx`, "utf8");

    expect(index).not.toMatch(/\.\/serve\.js/);
    expect(index).not.toMatch(/node-pty|@wterm\/dom|@wterm\/core|from "ws"/);
  });
});
