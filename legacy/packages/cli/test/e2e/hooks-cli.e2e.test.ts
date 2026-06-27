import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { describe, expect, it, afterEach } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
const tmpRoot = join(repoRoot, ".tmp-tests");

describe("acpus hooks CLI", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  function workspaceWith(hooks?: unknown): string {
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(join(tmpRoot, "acpus-hooks-cli-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    if (hooks !== undefined) {
      mkdirSync(join(dir, ".acpus"), { recursive: true });
      writeFileSync(join(dir, ".acpus", "hooks.yaml"), JSON.stringify(hooks), "utf8");
    }
    return dir;
  }

  const run = (cwd: string, args: string[]) =>
    execaNode(cliEntry, args, {
      cwd,
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

  it("validate --json returns ok for a well-formed project config", async () => {
    const cwd = workspaceWith({ events: { afterRun: [{ command: "echo hi" }] } });
    const result = await run(cwd, ["hooks", "validate", "--project", cwd, "--json"]);
    const payload = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.diagnostics).toContainEqual({
      injectorOrEvent: "afterRun",
      index: 0,
      source: "project",
      ok: true
    });
  });

  it("validate text output reports configured valid handlers", async () => {
    const cwd = workspaceWith({ events: { afterRun: [{ command: "echo hi" }] } });
    const result = await run(cwd, ["hooks", "validate", "--project", cwd]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[ok] project afterRun#0");
    expect(result.stdout).not.toContain("No hooks configured");
  });

  it("validate exits 1 for a malformed handler", async () => {
    const cwd = workspaceWith({ injectors: { beforeAgentExec: [{}] } });
    const result = await run(cwd, ["hooks", "validate", "--project", cwd, "--json"]);
    const payload = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.parseError).toBeUndefined();
    expect(payload.diagnostics).toContainEqual({
      injectorOrEvent: "beforeAgentExec",
      index: 0,
      source: "project",
      ok: false,
      message: "command must be a non-empty string"
    });
  });

  it("validate reports unknown hook names as diagnostics", async () => {
    const cwd = workspaceWith({ events: { afterrun: [{ command: "x" }] } });
    const result = await run(cwd, ["hooks", "validate", "--project", cwd, "--json"]);
    const payload = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(payload.parseError).toBeUndefined();
    expect(payload.diagnostics).toContainEqual({
      injectorOrEvent: "afterrun",
      source: "project",
      ok: false,
      message: "unknown hook name 'afterrun' in events"
    });
  });

  it("list shows merged handlers grouped by injectors/events", async () => {
    const cwd = workspaceWith({
      injectors: { beforeAgentExec: [{ command: "inject.sh" }] },
      events: { afterRun: [{ command: "curl -X POST https://example.test/hook", sync: true }] }
    });
    const result = await run(cwd, ["hooks", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("injectors:");
    expect(result.stdout).toContain("beforeAgentExec");
    expect(result.stdout).toContain("inject.sh");
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain("curl -X POST https://example.test/hook");
  });

  it("list reports no hooks when none configured", async () => {
    const cwd = workspaceWith();
    const result = await run(cwd, ["hooks", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No hooks configured");
  });

  it("path prints project path with existence marker", async () => {
    const cwd = workspaceWith({ events: { afterRun: [{ command: "x" }] } });
    const result = await run(cwd, ["hooks", "path"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".acpus/hooks.yaml (exists)");
  });
});
