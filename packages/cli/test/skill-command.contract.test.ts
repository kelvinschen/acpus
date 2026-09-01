import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("skill command contracts", () => {
  it("rejects removed installation commands as usage errors", async () => {
    await withPlainTestWorkspace("skill-removed-commands", async workspace => {
      for (const command of ["install", "uninstall"]) {
        const stdout = new CaptureStream();
        const stderr = new CaptureStream();

        expect(await runCli(["skill", command], { cwd: workspace, stdout, stderr })).toBe(2);
        expect(stdout.text).toBe("");
        expect(stderr.text).toContain(`unknown command '${command}'`);
      }
    });
  });
});
