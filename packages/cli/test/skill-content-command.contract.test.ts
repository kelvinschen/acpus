import { Readable } from "node:stream";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCliPackageInfo } from "../src/platform/package-info.js";
import { CliError } from "../src/presentation/errors.js";
import { createSkillCommand } from "../src/skill/command.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("skill content CLI contracts", () => {
  it("does not alter the bundled entry while exposing its canonical path", async () => {
    await withPlainTestWorkspace("skill-content-read", async workspace => {
      const root = await realpath(join(getCliPackageInfo().packageRoot, "skills", "acpus"));
      const entryPath = await realpath(join(root, "SKILL.md"));
      const body = await readFile(entryPath, "utf8");

      const result = await runCommand(workspace, ["skill", "read"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const metadata = metadataBeforeBody(result.stdout, body);
      expect(metadata).toContain(`path: ${entryPath}\n`);
      expect(metadata).toContain("kind: file\n");
    });
  });

  it("does not create runtime or installed-skill state while reading", async () => {
    await withPlainTestWorkspace("skill-content-read-only", async workspace => {
      expect((await runCommand(workspace, ["skill", "read"])).exitCode).toBe(0);

      await expect(lstat(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(workspace, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(workspace, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("maps a resource failure to the skill phase without partial output", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const command = createSkillCommand({
      cwd: process.cwd(),
      stdin: Readable.from([]),
      stdout,
      stderr,
      setExitCode: () => {},
    });

    let failure: unknown;
    try {
      await command.parseAsync(["read", "missing.md"], { from: "user" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      exitCode: 1,
      result: { ok: false, phase: "skill" },
    });
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
  });

  it("does not accept bulk, raw, recursive, or excess-argument forms", async () => {
    await withPlainTestWorkspace("skill-content-usage", async workspace => {
      for (const option of ["--all", "--full", "--raw", "--recursive"]) {
        const result = await runCommand(workspace, ["skill", "read", option]);
        expect(result.exitCode, option).toBe(2);
        expect(result.stdout).toBe("");
      }
      const excess = await runCommand(workspace, ["skill", "read", "one", "two"]);
      expect(excess.exitCode).toBe(2);
      expect(excess.stdout).toBe("");
    });
  });
});

function metadataBeforeBody(output: string, body: string): string {
  expect(output.endsWith(body)).toBe(true);
  return output.slice(0, -body.length);
}

async function runCommand(
  workspace: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}
