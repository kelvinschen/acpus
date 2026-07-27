import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTypeScript } from "../src/check/typescript.js";
import { sha256Digest } from "../src/digest.js";
import { createScratchDir } from "../src/preflight/temp.js";
import { runCheck, withCheckWorkspace } from "./support/check-workspace.js";

describe("workflow TypeScript diagnostics", () => {
  it("returns the digest of the source text supplied to the check", async () => {
    await withCheckWorkspace("workflow-check-digest", async cwd => {
      const source = "export default {};\n";

      const result = await runCheck(cwd, source);

      expect(result.sourceDigest).toBe(sha256Digest(source));
    });
  });

  it("converts TypeScript compiler diagnostics to DiagnosticIR", async () => {
    await withCheckWorkspace("workflow-ts-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        const wrong: string = 1;

        export default defineWorkflow({ name: "ts_check" }).build(() => ({ wrong }));
      `, {
        "tsconfig.json": `${JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          include: ["unrelated.ts"],
        }, null, 2)}\n`,
        "unrelated.ts": "const value: string = 1;\n",
      });

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS2322",
          message: expect.stringContaining("Type 'number' is not assignable to type 'string'"),
          source: expect.objectContaining({
            file: expect.stringContaining("workflow.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        }),
      ]));
      expect(result.diagnostics.filter(diagnostic => diagnostic.source?.file?.includes("unrelated.ts"))).toEqual([]);
    });
  });

  it("reports implicit any from TypeScript semantic diagnostics", async () => {
    await withCheckWorkspace("workflow-implicit-any-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        function id(value) {
          return value;
        }

        export default defineWorkflow({ name: "implicit_any_check" }).build(() => ({ value: id("ok") }));
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS7006",
          message: expect.stringContaining("implicitly has an 'any' type"),
        }),
      ]));
    });
  });

  it("does not duplicate bind diagnostics already included in semantic diagnostics", async () => {
    await withCheckWorkspace("workflow-bind-diagnostic", async cwd => {
      const result = await runCheck(cwd, `
        const repeated = 1;
        const repeated = 2;
        export default {};
      `);

      expect(result.diagnostics.filter(({ code }) => code === "TS2451")).toHaveLength(2);
    });
  });

  it("flattens chained TypeScript diagnostics", async () => {
    await withCheckWorkspace("workflow-chained-diagnostic", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        type Expected = { nested: { value: string } };
        const actual = { nested: { value: 1 } };
        const wrong: Expected = actual;

        export default defineWorkflow({ name: "chained_diagnostic" }).build(() => ({ wrong }));
      `);

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "TS2322",
        message: expect.stringMatching(/not assignable[\s\S]+nested\.value/),
      }));
    });
  });

  it("checks the supplied source overlay instead of stale disk text", async () => {
    await withCheckWorkspace("workflow-source-overlay", async cwd => {
      const entry = join(cwd, "workflow.ts");
      const diskSource = "const value: string = 'disk';\nexport default {};\n";
      const overlaySource = "const value: string = 1;\nexport default {};\n";
      await writeFile(entry, diskSource);
      const scratchDir = await createScratchDir();
      try {
        const result = await checkTypeScript(entry, cwd, scratchDir, overlaySource);
        if (result.isErr()) throw new Error(result.error.message);
        expect(result.value.diagnostics).toContainEqual(expect.objectContaining({ code: "TS2322" }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });
});
