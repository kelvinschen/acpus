import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { toolData, withMcpClient } from "./support/mcp-client.js";
import { withAuthoringTestWorkspace } from "./support/workspace.js";

afterEach(() => vi.unstubAllEnvs());

it("prepares a dry run through MCP without admitting a Run or executing its Tasks", async () => {
  await withAuthoringTestWorkspace("mcp-dry-run", async (workspace, home) => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const marker = join(workspace, "task-executed");
    const source = `import { defineWorkflow, z } from "acpus/core";
export default defineWorkflow({ name: "dry-run", inputSchema: z.null(), agents: { worker: {} } }).build(({ step }) => step("write").task({
  input: ${JSON.stringify(marker)},
  exec: async ({ input }) => { const { writeFile } = await import("node:fs/promises"); await writeFile(input, "executed"); return { ok: true }; },
}).output);`;
    await withMcpClient(async client => {
      const checked = toolData(await client.callTool({ name: "acpus_run", arguments: { workspace, source, dryRun: true } }));
      expect(checked).toMatchObject({ workspace, dryRun: true, workflow: { name: "dry-run", nodeCount: 1 }, diagnostics: [], unboundAgents: ["worker"] });
      expect(checked.runId).toBeUndefined();
      expect(toolData(await client.callTool({ name: "acpus_list_runs", arguments: { workspace } })).runs).toEqual([]);
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(home)).toEqual([]);
  });
});
