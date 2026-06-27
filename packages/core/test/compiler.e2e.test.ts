import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("core compiler CLI", () => {
  it("emits WorkflowIR for the checked-in release example", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpus-core-e2e-"));
    const out = join(dir, "release.ir.json");

    try {
      const result = await execa("pnpm", [
        "exec",
        "tsx",
        "packages/core/src/compiler/cli.ts",
        "packages/core/examples/release.workflow.ts",
        "--out",
        out,
        "--pretty",
      ], { cwd: repoRoot });

      expect(result.stdout.trim()).toBe(out);

      const ir = JSON.parse(await readFile(out, "utf8")) as {
        irVersion: number;
        name: string;
        root: { nodes: Array<{ id: string; kind: string }> };
        assets: { taskBundles: Record<string, { digest: string }> };
        diagnostics: Array<{ code: string; severity: string }>;
        lock: { workflowSourceDigest?: string };
        outputs: Record<string, unknown>;
      };

      expect(ir.irVersion).toBe(2);
      expect(ir.name).toBe("release-readiness");
      expect(ir.root.nodes.map(node => node.id)).toEqual([
        "normalize_package",
        "prepare_release",
        "run_tests",
        "require_tests",
        "review_security",
        "review_performance",
        "review_docs",
        "require_all_reviews_ready",
        "final_summary",
      ]);
      expect(Object.keys(ir.assets.taskBundles)).toHaveLength(3);
      expect(Object.values(ir.assets.taskBundles).every(bundle => bundle.digest.startsWith("sha256:"))).toBe(true);
      expect(ir.lock.workflowSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(ir.diagnostics).toEqual([
        expect.objectContaining({
          code: "C001",
          severity: "warning",
        }),
      ]);
      expect(Object.keys(ir.outputs).sort()).toEqual(["changelogDraft", "maxRiskCount", "ready", "summary"]);
    } finally {
      await unlink(out).catch(() => undefined);
      await rmdir(dir).catch(() => undefined);
    }
  });
});
