import { rm } from "node:fs/promises";
import { join } from "node:path";
import { API, Snapshot } from "typescript/unstable/sync";
import { describe, expect, it, vi } from "vitest";
import { checkWorkflow } from "../src/check/runner.js";
import { createScratchDir } from "../src/preflight/temp.js";
import { runCheck, withCheckWorkspace } from "./support/check-workspace.js";

describe("workflow native check lifecycle", () => {
  it("disposes the native snapshot before closing the API", async () => {
    const events: string[] = [];
    const originalDispose = Snapshot.prototype.dispose;
    const originalClose = API.prototype.close;
    const dispose = vi.spyOn(Snapshot.prototype, "dispose").mockImplementation(function (this: Snapshot) {
      events.push("dispose");
      return originalDispose.call(this);
    });
    const close = vi.spyOn(API.prototype, "close").mockImplementation(function (this: API) {
      const child = (this as unknown as {
        client: { channel: { child: { exitCode: number | null; signalCode: NodeJS.Signals | null } } };
      }).client.channel.child;
      events.push(child.exitCode !== null || child.signalCode !== null ? "close-exited" : "close-live");
      return originalClose.call(this);
    });
    try {
      await withCheckWorkspace("workflow-native-lifecycle", async cwd => {
        const result = await runCheck(cwd, "export default {};\n");
        expect(result.diagnostics.some(diagnostic => diagnostic.code === "WF002")).toBe(false);
      });
      expect(events.slice(-2)).toEqual(["dispose", "close-exited"]);
    } finally {
      dispose.mockRestore();
      close.mockRestore();
    }
  });

  it("maps cleanup failures to WF002 after closing the native API", async () => {
    const events: string[] = [];
    const originalDispose = Snapshot.prototype.dispose;
    const originalClose = API.prototype.close;
    const dispose = vi.spyOn(Snapshot.prototype, "dispose").mockImplementation(function (this: Snapshot) {
      events.push("dispose");
      originalDispose.call(this);
      throw new Error("snapshot cleanup failed");
    });
    const close = vi.spyOn(API.prototype, "close").mockImplementation(function (this: API) {
      events.push("close");
      return originalClose.call(this);
    });
    try {
      await withCheckWorkspace("workflow-native-cleanup-failure", async cwd => {
        const result = await runCheck(cwd, "export default {};\n");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          code: "WF002",
          message: expect.stringContaining("snapshot cleanup failed"),
        }));
      });
      expect(events.slice(-2)).toEqual(["dispose", "close"]);
    } finally {
      dispose.mockRestore();
      close.mockRestore();
    }
  });

  it("preserves the primary native failure when cleanup also fails", async () => {
    const originalDispose = Snapshot.prototype.dispose;
    const getProject = vi.spyOn(Snapshot.prototype, "getProject").mockReturnValue(undefined);
    const dispose = vi.spyOn(Snapshot.prototype, "dispose").mockImplementation(function (this: Snapshot) {
      originalDispose.call(this);
      throw new Error("secondary cleanup failure");
    });
    try {
      await withCheckWorkspace("workflow-native-primary-failure", async cwd => {
        const result = await runCheck(cwd, "export default {};\n");
        const failure = result.diagnostics.find(diagnostic => diagnostic.code === "WF002");
        expect(failure?.message).toContain("did not open project");
        expect(failure?.message).not.toContain("secondary cleanup failure");
      });
    } finally {
      getProject.mockRestore();
      dispose.mockRestore();
    }
  });

  it("isolates concurrent native checks across workspaces", async () => {
    const [assignment, implicitAny] = await Promise.all([
      withCheckWorkspace("workflow-concurrent-assignment", cwd => runCheck(cwd, `
        const wrong: string = 1;
        export default { wrong };
      `)),
      withCheckWorkspace("workflow-concurrent-implicit-any", cwd => runCheck(cwd, `
        function identity(value) { return value; }
        export default { value: identity("ok") };
      `)),
    ]);

    expect(assignment.diagnostics).toContainEqual(expect.objectContaining({
      code: "TS2322",
      source: expect.objectContaining({ file: expect.stringContaining("workflow-concurrent-assignment") }),
    }));
    expect(implicitAny.diagnostics).toContainEqual(expect.objectContaining({
      code: "TS7006",
      source: expect.objectContaining({ file: expect.stringContaining("workflow-concurrent-implicit-any") }),
    }));
    expect([...assignment.diagnostics, ...implicitAny.diagnostics].some(({ code }) => code === "WF002")).toBe(false);
  });

  it("reports missing workflow source as a check diagnostic", async () => {
    await withCheckWorkspace("workflow-missing-check", async cwd => {
      const scratchDir = await createScratchDir();
      try {
        const result = await checkWorkflow(join(cwd, "missing.workflow.ts"), cwd, scratchDir);

        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          code: "WF001",
          path: "workflow",
          source: expect.objectContaining({ file: expect.stringContaining("missing.workflow.ts") }),
        }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });
});
