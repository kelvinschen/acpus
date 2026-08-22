import * as Result from "effect/Result";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Digest } from "@acpus/core/content-identity";
import { describe, expect, it } from "vitest";
import { checkTypeScript } from "../src/check/typescript.js";
import { createScratchDir } from "../src/preflight/temp.js";
import { runCheck, withCheckWorkspace } from "./support/check-workspace.js";

describe("workflow TypeScript diagnostics", () => {
  it("digests the exact supplied source while retaining its UTF-8 BOM", async () => {
    await withCheckWorkspace("workflow-check-digest", async cwd => {
      const source = "\ufeffexport default {};\n";

      const result = await runCheck(cwd, source);

      expect(result.sourceDigest).toBe(sha256Digest(source));
      expect(result.sourceFiles?.find(file => file.path === join(cwd, "workflow.ts"))?.content).toBe(source);
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

  it("warns for every recognizable module load outside the tracked source graph", async () => {
    await withCheckWorkspace("workflow-source-capture-warnings", async cwd => {
      const result = await runCheck(cwd, `
        import { createRequire as makeRequire } from "node:module";
        import { defineWorkflow } from "acpus/core";
        import type { DeclaredOnly } from "./declared-only.js";

        const requireFromHere = makeRequire(import.meta.url);
        export function dynamic(name: string): Promise<unknown> { return import(name); }
        export function relativeRequire(): unknown { return require("./helper.js"); }
        export function absoluteLoad(): Promise<unknown> { return import("file:///tmp/acpus-untracked.js"); }
        void requireFromHere;
        void (null as DeclaredOnly | null);

        export default defineWorkflow({ name: "source_capture_warnings" }).build(() => ({}));
      `, {
        "declared-only.d.ts": "export type DeclaredOnly = { ok: true };\n",
        "helper.ts": "export const helper = true;\n",
      });

      const warnings = result.diagnostics.filter(diagnostic => diagnostic.code === "SC001");
      expect(warnings.map(diagnostic => diagnostic.source?.line)).toEqual([4, 6, 7, 8, 9]);
      expect(warnings.every(
        diagnostic => diagnostic.severity === "warning" && diagnostic.source?.file?.endsWith("workflow.ts") === true,
      )).toBe(true);
    });
  });

  it("does not treat shadowed require and createRequire names as runtime loaders", async () => {
    await withCheckWorkspace("workflow-source-capture-shadows", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        function require(value: string): string { return value; }
        function createRequire(value: string): string { return value; }
        void require("./helper.js");
        void createRequire(import.meta.url);

        export default defineWorkflow({ name: "source_capture_shadows" }).build(() => ({}));
      `, {
        "helper.ts": "export const helper = true;\n",
      });

      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "SC001")).toEqual([]);
    });
  });

  it("warns and stops when a static local import resolves to unsupported source", async () => {
    await withCheckWorkspace("workflow-source-capture-json", async cwd => {
      const result = await runCheck(cwd, `
        // @ts-ignore JSON is intentionally outside the supported source graph.
        import value from "./data.json";
        void value;
        export default {};
      `, {
        "data.json": "{\"value\":true}\n",
      });

      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "SC001")).toEqual([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("resolves to an unsupported source file"),
          source: expect.objectContaining({ file: expect.stringContaining("workflow.ts"), line: 3 }),
        }),
      ]);
      expect(result.sourceFiles?.map(file => file.path)).toEqual([join(cwd, "workflow.ts")]);
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
        if (Result.isFailure(result)) throw new Error(result.failure.message);
        expect(result.success.diagnostics).toContainEqual(expect.objectContaining({ code: "TS2322" }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });
});
