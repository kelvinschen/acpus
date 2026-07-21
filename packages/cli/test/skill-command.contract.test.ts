import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCliPackageInfo } from "../src/package-info.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withTestWorkspace } from "./support/workspace.js";

const promptMocks = vi.hoisted(() => ({
  cancel: Symbol("cancel"),
  multiselect: vi.fn(),
  select: vi.fn(),
}));
const osMocks = vi.hoisted(() => ({ homedir: vi.fn() }));

vi.mock("@clack/prompts", async importOriginal => ({
  ...await importOriginal<typeof import("@clack/prompts")>(),
  isCancel: (value: unknown) => value === promptMocks.cancel,
  multiselect: promptMocks.multiselect,
  select: promptMocks.select,
}));

vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: osMocks.homedir,
}));

describe("skill CLI contracts", () => {
  beforeEach(() => {
    promptMocks.multiselect.mockReset();
    promptMocks.select.mockReset();
    osMocks.homedir.mockReset();
  });

  it("prompts for a complete TTY selection with project and both agents as defaults", async () => {
    await withTestWorkspace("skill-tty-full", async workspace => {
      promptMocks.select.mockResolvedValueOnce("project");
      promptMocks.multiselect.mockResolvedValueOnce(["claude", "universal"]);

      const result = await runSkill(workspace, [], true);
      const universal = join(workspace, ".agents", "skills", "acpus");
      const claude = join(workspace, ".claude", "skills", "acpus");

      expect(result.exitCode).toBe(0);
      expect(promptMocks.select).toHaveBeenCalledOnce();
      expect(promptMocks.select.mock.calls[0]![0]).toMatchObject({
        initialValue: "project",
        input: result.stdin,
        output: result.stderr,
      });
      expect(promptMocks.multiselect).toHaveBeenCalledOnce();
      expect(promptMocks.multiselect.mock.calls[0]![0]).toMatchObject({
        initialValues: ["universal", "claude"],
        required: true,
        input: result.stdin,
        output: result.stderr,
      });
      expect(result.stdout.text).toContain(`installed\tuniversal\t${universal}\ninstalled\tclaude\t${claude}`);
      expect((await lstat(universal)).isDirectory()).toBe(true);
      expect((await lstat(claude)).isDirectory()).toBe(true);
    });
  });

  it("prompts only for parameters missing from a TTY invocation", async () => {
    await withTestWorkspace("skill-tty-partial", async workspace => {
      const home = join(workspace, "home");
      osMocks.homedir.mockReturnValue(home);
      promptMocks.multiselect.mockResolvedValueOnce(["claude"]);

      const global = await runSkill(workspace, ["--global"], true);

      expect(global.exitCode).toBe(0);
      expect(promptMocks.select).not.toHaveBeenCalled();
      expect(promptMocks.multiselect).toHaveBeenCalledOnce();
      expect(global.stdout.text).toContain(`installed\tclaude\t${join(home, ".claude", "skills", "acpus")}`);

      promptMocks.select.mockResolvedValueOnce("project");
      const project = await runSkill(workspace, ["--agent", "claude"], true);

      expect(project.exitCode).toBe(0);
      expect(promptMocks.select).toHaveBeenCalledOnce();
      expect(promptMocks.multiselect).toHaveBeenCalledOnce();
      expect(project.stdout.text).toContain(`installed\tclaude\t${join(workspace, ".claude", "skills", "acpus")}`);
    });
  });

  it("skips prompts when a TTY invocation already provides scope and agents", async () => {
    await withTestWorkspace("skill-tty-complete", async workspace => {
      const result = await runSkill(workspace, ["--project", "--agent", "universal"], true);

      expect(result.exitCode).toBe(0);
      expect(promptMocks.select).not.toHaveBeenCalled();
      expect(promptMocks.multiselect).not.toHaveBeenCalled();
      expect((await lstat(join(workspace, ".agents", "skills", "acpus"))).isDirectory()).toBe(true);
      await expect(lstat(join(workspace, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("maps TTY cancellation to usage without creating files", async () => {
    await withTestWorkspace("skill-tty-cancel", async workspace => {
      promptMocks.select.mockResolvedValueOnce(promptMocks.cancel);

      const result = await runSkill(workspace, ["--agent", "universal"], true);

      expect(result.exitCode).toBe(2);
      expect(result.stdout.text).toBe("");
      expect(result.stderr.text).toContain("Skill selection cancelled.");
      await expect(lstat(join(workspace, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("requires an explicit scope and agent selection outside a TTY", async () => {
    await withTestWorkspace("skill-non-tty-required", async workspace => {
      for (const args of [[], ["--project"], ["--agent", "universal"]]) {
        const result = await runSkill(workspace, args);
        expect(result.exitCode).toBe(2);
        expect(result.stdout.text).toBe("");
        expect(result.stderr.text).toContain("requires one of --project or --global and --agent");
      }
      await expect(lstat(join(workspace, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects conflicting scopes, invalid agents, and removed options as usage", async () => {
    await withTestWorkspace("skill-invalid-options", async workspace => {
      const invalid = [
        { args: ["--project", "--global", "--agent", "universal"], message: "Pass only one of --project or --global." },
        { args: ["--project", "--agent", "universal,,claude"], message: "without empty values" },
        { args: ["--project", "--agent", "codex"], message: "only universal and/or claude" },
      ];
      for (const testCase of invalid) {
        const result = await runSkill(workspace, testCase.args);
        expect(result.exitCode).toBe(2);
        expect(result.stderr.text).toContain(testCase.message);
      }

      for (const args of [
        ["install", "--project", "--agent", "universal", "--dir", "skills"],
        ["install", "--project", "--agent", "universal", "--json"],
        ["uninstall", "--project", "--agent", "universal", "--json"],
      ]) {
        const result = await runCommand(workspace, ["skill", ...args]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout.text).toBe("");
        expect(result.stderr.text).toContain("unknown option");
      }
    });
  });

  it("trims, deduplicates, and canonically orders comma-separated agents", async () => {
    await withTestWorkspace("skill-agent-order", async workspace => {
      const result = await runSkill(workspace, ["--project", "--agent", " claude, universal,claude "]);
      const universal = join(workspace, ".agents", "skills", "acpus");
      const claude = join(workspace, ".claude", "skills", "acpus");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toContain(`installed\tuniversal\t${universal}\ninstalled\tclaude\t${claude}`);
    });
  });

  it("uses the operating-system home for exact global targets", async () => {
    await withTestWorkspace("skill-global-targets", async workspace => {
      const home = join(workspace, "isolated-home");
      osMocks.homedir.mockReturnValue(home);

      const result = await runSkill(workspace, ["--global", "--agent", "universal,claude"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toContain(`installed\tuniversal\t${join(home, ".agents", "skills", "acpus")}`);
      expect(result.stdout.text).toContain(`installed\tclaude\t${join(home, ".claude", "skills", "acpus")}`);
      await expect(lstat(join(workspace, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reports missing roots in dry-run without creating them", async () => {
    await withTestWorkspace("skill-install-dry-run", async workspace => {
      const result = await runSkill(workspace, ["--project", "--agent", "universal,claude", "--dry-run"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toContain("would-install\tuniversal");
      expect(result.stdout.text).toContain("would-install\tclaude");
      await expect(lstat(join(workspace, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(workspace, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("updates an owned target and replaces an owned target symlink atomically", async () => {
    await withTestWorkspace("skill-update", async workspace => {
      const target = join(workspace, ".agents", "skills", "acpus");
      const linked = join(workspace, "linked-acpus");
      await writeSkill(linked, "0.0.0");
      await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
      await symlink(linked, target, "dir");

      const result = await runSkill(workspace, ["--project", "--agent", "universal"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toContain(`updated\tuniversal\t${target}`);
      expect((await lstat(target)).isDirectory()).toBe(true);
      expect((await lstat(target)).isSymbolicLink()).toBe(false);
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain(`acpus-version: ${getCliPackageInfo().version}`);
      expect(await readFile(join(linked, "SKILL.md"), "utf8")).toContain("acpus-version: 0.0.0");
    });
  });

  it("continues other targets when one root or target is unsafe", async () => {
    await withTestWorkspace("skill-partial-failure", async workspace => {
      await mkdir(join(workspace, ".agents"));
      await writeFile(join(workspace, ".agents", "skills"), "not a directory");

      const result = await runSkill(workspace, ["--project", "--agent", "universal,claude"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout.text).toBe("");
      expect(result.stderr.text).toContain("failed\tuniversal");
      expect(result.stderr.text).toContain("skills root is not a directory");
      expect(result.stderr.text).toContain("installed\tclaude");
      expect((await lstat(join(workspace, ".claude", "skills", "acpus"))).isDirectory()).toBe(true);
      expect(await readFile(join(workspace, ".agents", "skills"), "utf8")).toBe("not a directory");
    });
  });

  it("rejects dangling skills-root symlinks without replacing them", async () => {
    await withTestWorkspace("skill-dangling-root", async workspace => {
      await mkdir(join(workspace, ".agents"));
      const root = join(workspace, ".agents", "skills");
      await symlink(join(workspace, "missing-skills"), root, "dir");

      const result = await runSkill(workspace, ["--project", "--agent", "universal"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.text).toContain("skills root is not a directory");
      expect((await lstat(root)).isSymbolicLink()).toBe(true);
    });
  });

  it("supports symlinked skills roots for install and uninstall", async () => {
    await withTestWorkspace("skill-symlink-root", async workspace => {
      const realRoot = join(workspace, "real-skills");
      await mkdir(realRoot);
      await mkdir(join(workspace, ".agents"));
      await symlink(realRoot, join(workspace, ".agents", "skills"), "dir");

      const installed = await runSkill(workspace, ["--project", "--agent", "universal"]);
      expect(installed.exitCode).toBe(0);
      expect((await lstat(join(realRoot, "acpus"))).isDirectory()).toBe(true);

      const removed = await runSkill(workspace, ["--project", "--agent", "universal"], false, "uninstall");
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout.text).toContain("removed\tuniversal");
      await expect(lstat(join(realRoot, "acpus"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not create roots during uninstall and preserves unsafe targets", async () => {
    await withTestWorkspace("skill-uninstall-safety", async workspace => {
      const missing = await runSkill(workspace, ["--project", "--agent", "claude"], false, "uninstall");
      expect(missing.exitCode).toBe(0);
      expect(missing.stdout.text).toContain("missing\tclaude");
      await expect(lstat(join(workspace, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });

      const target = join(workspace, ".agents", "skills", "acpus");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), "---\nname: another-skill\n---\n");
      const unsafe = await runSkill(workspace, ["--project", "--agent", "universal"], false, "uninstall");
      expect(unsafe.exitCode).toBe(1);
      expect(unsafe.stderr.text).toContain("skipped\tuniversal");
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("another-skill");
    });
  });

  it("keeps an installed skill during uninstall dry-run", async () => {
    await withTestWorkspace("skill-uninstall-dry-run", async workspace => {
      const target = join(workspace, ".agents", "skills", "acpus");
      await writeSkill(target, getCliPackageInfo().version);

      const result = await runSkill(workspace, ["--project", "--agent", "universal", "--dry-run"], false, "uninstall");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toContain(`would-remove\tuniversal\t${target}`);
      expect((await lstat(target)).isDirectory()).toBe(true);
    });
  });
});

async function runSkill(
  workspace: string,
  args: string[],
  tty = false,
  action: "install" | "uninstall" = "install",
): Promise<CommandRun> {
  return runCommand(workspace, ["skill", action, ...args], tty);
}

async function runCommand(workspace: string, args: string[], tty = false): Promise<CommandRun> {
  const stdin = tty ? new TtyInput() : undefined;
  const stdout = tty ? new TtyCaptureStream() : new CaptureStream();
  const stderr = tty ? new TtyCaptureStream() : new CaptureStream();
  const exitCode = await runCli(args, { cwd: workspace, ...(stdin ? { stdin } : {}), stdout, stderr });
  return { exitCode, stdin, stdout, stderr };
}

type CommandRun = {
  exitCode: number;
  stdin: TtyInput | undefined;
  stdout: CaptureStream;
  stderr: CaptureStream;
};

async function writeSkill(path: string, version: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: acpus\nmetadata:\n  acpus-version: ${version}\n---\n`);
}

class TtyInput extends Readable {
  readonly isTTY = true;

  setRawMode(_mode: boolean): this {
    return this;
  }

  override _read(): void {}
}

class TtyCaptureStream extends CaptureStream {
  readonly isTTY = true;
}
