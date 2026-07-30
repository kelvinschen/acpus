import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withDaemonTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("follows a workflow path with an append-only text transcript", async () => {
    await withDaemonTestWorkspace("e2e-run-path", async (workspace, home) => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const input = "sample input.JSON";
      await writeFile(join(workspace, input), "{\"ready\":true}\n");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", input, "--follow"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const [runId] = result.stdout.match(/\d{14}[A-F0-9]{20}/gu) ?? [];
      expect(runId).toMatch(runIdPattern);
      expect(result.stdout).toContain(`Run ${runId}`);
      expect(result.stdout).toMatch(/completed/u);
      expect(result.stdout).toContain("Output:\n  {\n    \"ready\": true\n  }");
      expect(result.stdout).not.toContain('"schemaVersion"');
      await expect(access(join(home, ".acpus", "workspaces"))).resolves.toBeUndefined();
      await expect(access(join(workspace, ".acpus", ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

});
