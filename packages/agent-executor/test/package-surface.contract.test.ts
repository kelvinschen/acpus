import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("@acpus/agent-executor default package surface", () => {
  it("builds to the current public API for default Node consumers", async () => {
    await exec("pnpm", ["--filter", "@acpus/agent-executor", "build"], { cwd: repoRoot });

    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "-e",
      "const mod = await import('@acpus/agent-executor'); console.log(JSON.stringify(Object.keys(mod).sort()));",
    ], { cwd: repoRoot });

    expect(JSON.parse(stdout)).toEqual(["executeAgentTurn"]);
  });
});
