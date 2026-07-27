import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { typescriptNativeDiagnostic } from "../src/check/runner.js";
import { withNativeProject } from "../src/typescript/native.js";

describe("TypeScript native boundary", () => {
  it("tags native process startup failure as an infrastructure failure", async () => {
    const cwd = process.cwd();
    const result = await withNativeProject({
      configPath: join(cwd, "missing-tsconfig.json"),
      cwd,
      sourcePath: join(cwd, "missing-workflow.ts"),
      source: "export default {};\n",
      tsserverPath: join(cwd, "missing-tsgo"),
    }, () => undefined);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual(expect.objectContaining({
      type: "typescript-native-failed",
      message: expect.stringContaining("does not exist"),
    }));
  });

  it("maps infrastructure failures to WF002 without exposing native objects", () => {
    const diagnostic = typescriptNativeDiagnostic(
      "/workspace/workflow.ts",
      {
        type: "typescript-native-failed",
        message: "TypeScript native analysis failed: unavailable",
      },
    );

    expect(diagnostic).toEqual({
      code: "WF002",
      severity: "error",
      message: "TypeScript native analysis failed: unavailable",
      path: "workflow",
      source: {
        file: "/workspace/workflow.ts",
        line: 1,
        column: 1,
      },
    });
  });
});
