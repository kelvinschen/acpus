import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requestDaemonShutdown } from "@acpus/runtime";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "acpus-dist-smoke-"));
const execFileAsync = promisify(execFile);

try {
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const workflow = join(workspace, "workflow.ts");
  await cp(join(root, "packages/cli/test/fixtures/workflows/concurrency/short-task.workflow.ts"), workflow);

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(root, "packages/cli/dist/cli.js"), "workflow", "run", workflow, "--json",
  ], {
    cwd: workspace,
    env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1", NODE_OPTIONS: "" },
  });
  assert.equal(stderr, "");

  const records = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(pickRunResult(records[0]), {
    ok: true,
    phase: "run",
    kind: "admitted",
    name: "cli-concurrency-short-task",
    status: "pending",
  });
  assert.deepEqual(pickRunResult(records.at(-1)), {
    ok: true,
    phase: "run",
    kind: "terminal summary",
    name: "cli-concurrency-short-task",
    status: "completed",
    output: { ok: true },
  });
} finally {
  await requestDaemonShutdown(workspace).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
}

function pickRunResult(record) {
  return {
    ok: record?.ok,
    phase: record?.phase,
    kind: record?.kind,
    name: record?.run?.name,
    status: record?.run?.status,
    ...(record?.run?.output === undefined ? {} : { output: record.run.output }),
  };
}
