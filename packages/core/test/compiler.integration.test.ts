import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileWorkflowModule } from "../src/index.js";

describe("workflow module compiler", () => {
  it("compiles a workflow module through the module API", async () => {
    const entry = fileURLToPath(new URL("fixtures/module.workflow.mjs", import.meta.url));
    const ir = await compileWorkflowModule(entry, {
      sourcePath: "packages/core/test/fixtures/module.workflow.mjs",
    });

    expect(ir.irVersion).toBe(2);
    expect(ir.name).toBe("module-fixture");
    expect(ir.root.nodes.map(node => node.id)).toEqual([
      "normalize_package",
      "review",
      "require_ready",
    ]);
    expect(ir.root.nodes.map(node => node.kind)).toEqual(["task", "agent", "guard"]);
    expect(Object.keys(ir.assets.taskBundles)).toHaveLength(1);
    expect(Object.values(ir.assets.taskBundles).every(bundle => bundle.digest.startsWith("sha256:"))).toBe(true);
    expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ir.diagnostics).toEqual([
      expect.objectContaining({
        code: "C001",
        severity: "warning",
      }),
    ]);
    expect(Object.keys(ir.outputs).sort()).toEqual(["ready", "slug"]);
  });
});
