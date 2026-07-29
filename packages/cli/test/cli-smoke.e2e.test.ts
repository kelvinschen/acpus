import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withDaemonTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("follows a workflow path in JSON mode", async () => {
    await withDaemonTestWorkspace("e2e-run-path", async (workspace, home) => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const input = "sample input.JSON";
      await writeFile(join(workspace, input), "{\"ready\":true}\n");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", input, "--follow", "--json"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ schemaVersion: 1, ok: true, phase: "run", kind: "admitted" });
      expect(records[0].run.id).toMatch(runIdPattern);
      const views = records.slice(1);
      expect(views.every(record => record.schemaVersion === 2
        && record.ok === true
        && record.phase === "run"
        && record.kind === "view"
        && record.document?.kind === "snapshot"
        && record.document.run?.id === records[0].run.id)).toBe(true);
      expect(views.at(-1)).toMatchObject({
        schemaVersion: 2,
        ok: true,
        phase: "run",
        kind: "view",
        document: {
          run: { status: "completed" },
          output: { ready: true },
        },
      });
      expect(views.filter(record => record.document?.output !== undefined)).toHaveLength(1);
      await expect(access(join(home, ".acpus", "workspaces"))).resolves.toBeUndefined();
      await expect(access(join(workspace, ".acpus", ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

});
