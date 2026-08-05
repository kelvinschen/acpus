import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryVisualizeWorkflowSource } from "../src/server/workflows.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("workflow visualization preparation", () => {
  it("prepares a selected workflow in memory through the compiler seam", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-web-visualization-"));
    try {
      await symlink(join(repoRoot, "node_modules"), join(cwd, "node_modules"), "dir");
      await mkdir(join(cwd, "packages"));
      await symlink(join(repoRoot, "packages", "core"), join(cwd, "packages", "core"), "dir");
      await writeFile(join(cwd, "..release.workflow.ts"), `import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow({
  name: "web-integration",
  description: "Prepared through the Web compiler seam.",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("check").assert({ condition: input.ready });
  return { ready: input.ready };
});
`);
      const workspaceEntries = (await readdir(cwd)).sort();

      const result = await tryVisualizeWorkflowSource(cwd, {
        kind: "file",
        path: "..release.workflow.ts",
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw new Error(result.error.message);
      expect(result.value.workflow).toEqual({
        name: "web-integration",
        description: "Prepared through the Web compiler seam.",
        agents: {},
        irVersion: 7,
        nodeCount: 1,
      });
      expect(result.value.contract.inputSchema).toEqual({
        kind: "object",
        fields: { ready: { kind: "boolean" } },
        required: ["ready"],
        additionalProperties: false,
      });
      expect(result.value.contract.outputShape).toEqual({
        kind: "object",
        possibleKeys: ["ready"],
      });
      expect(result.value.graph.nodes.map(node => [node.id, node.kind])).toContainEqual([
        "check",
        "assert",
      ]);
      expect(result.value.sourceGraphDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect((await readdir(cwd)).sort()).toEqual(workspaceEntries);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
