import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("Agent Preset CLI contract", () => {
  it("lists the effective project-over-global catalog as natural-language text", async () => {
    await withPlainTestWorkspace("agent-preset-list", async (workspace, home) => {
      await withProcessHome(home, async () => {
        await writePresets(join(home, ".acpus", "config.json"), {
          "critical-reviewer": preset("Global review", { use: "claude", env: { GLOBAL_SECRET: "hidden" } }),
          "deep-coder": preset("Global coding", { command: "secret-global-agent --stdio" }),
        });
        await writePresets(join(workspace, ".acpus", "config.json"), {
          "deep-coder": preset("Project coding", { use: "codex", model: "private-model" }),
        });

        const effective = await invoke(workspace, ["agent", "presets"]);
        expect(effective.exitCode).toBe(0);
        expect(effective.stdout).toBe("Project presets:\n  deep-coder  Project coding\n\nGlobal presets:\n  critical-reviewer  Global review\n");
        expect(effective.stdout).not.toMatch(/GLOBAL_SECRET|hidden|secret-global-agent|private-model/u);
        expect(effective.stderr).toBe("");

        const global = await invoke(workspace, ["agent", "presets", "--global"]);
        expect(global.stdout).toBe("Global presets:\n  critical-reviewer  Global review\n  deep-coder         Global coding\n");
      });
    });
  });

  it("adds one complete Preset without exposing its Agent definition", async () => {
    await withPlainTestWorkspace("agent-preset-add", async (workspace, home) => {
      await withProcessHome(home, async () => {
        const definition = {
          guidance: "Complex implementation",
          agent: {
            use: "codex",
            model: "gpt-5.6-luna",
            config: { reasoning_effort: "high" },
            env: { PRIVATE_TOKEN: "secret" },
          },
        };
        const result = await invoke(workspace, [
          "agent", "presets", "add", "codex-luna", "--project", "--definition", JSON.stringify(definition),
        ]);

        expect(result).toEqual({
          exitCode: 0,
          stdout: "Agent Preset 'codex-luna' added to project scope.\n",
          stderr: "",
        });
        expect(result.stdout).not.toMatch(/gpt-5\.6-luna|reasoning_effort|PRIVATE_TOKEN|secret/u);
        expect(JSON.parse(await readFile(join(workspace, ".acpus", "config.json"), "utf8"))).toEqual({
          presets: { "codex-luna": definition },
        });

        const duplicate = await invoke(workspace, [
          "agent", "presets", "add", "codex-luna", "--project", "--definition", JSON.stringify(preset("Other", { use: "pi" })),
        ]);
        expect(duplicate.exitCode).toBe(1);
        expect(duplicate.stdout).toBe("");
        expect(duplicate.stderr).toContain("already exists in project scope");
        expect(JSON.parse(await readFile(join(workspace, ".acpus", "config.json"), "utf8"))).toEqual({
          presets: { "codex-luna": definition },
        });
      });
    });
  });

  it("removes one same-scope Preset while preserving the other config sections", async () => {
    await withPlainTestWorkspace("agent-preset-remove", async workspace => {
      const path = join(workspace, ".acpus", "config.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({
        agents: { worker: "worker --stdio" },
        presets: { reviewer: preset("Review", { use: "codex" }) },
        hooks: { "run.completed": [{ command: "echo done" }] },
      }));

      expect(await invoke(workspace, ["agent", "presets", "remove", "reviewer", "--project"])).toEqual({
        exitCode: 0,
        stdout: "Agent Preset 'reviewer' removed from project scope.\n",
        stderr: "",
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        agents: { worker: "worker --stdio" },
        hooks: { "run.completed": [{ command: "echo done" }] },
      });

      const missing = await invoke(workspace, ["agent", "presets", "remove", "reviewer", "--project"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain("does not exist in project scope");
    });
  });

  it("requires an explicit write scope before reading --definition or creating config", async () => {
    await withPlainTestWorkspace("agent-preset-scope", async workspace => {
      for (const scope of [[], ["--project", "--global"]]) {
        const result = await invoke(workspace, [
          "agent", "presets", "add", "reviewer", ...scope, "--definition", "missing.json",
        ]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/requires exactly one|mutually exclusive/u);

        const remove = await invoke(workspace, ["agent", "presets", "remove", "reviewer", ...scope]);
        expect(remove.exitCode).toBe(2);
        expect(remove.stdout).toBe("");
        expect(remove.stderr).toMatch(/requires exactly one|mutually exclusive/u);
      }
      await expect(lstat(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("keeps an empty listing read-only", async () => {
    await withPlainTestWorkspace("agent-preset-empty", async (workspace, home) => {
      await withProcessHome(home, async () => {
        const result = await invoke(workspace, ["agent", "presets"]);
        expect(result).toEqual({ exitCode: 0, stdout: "No Agent Presets.\n", stderr: "" });
        await expect(lstat(join(workspace, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(home, ".acpus"))).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  });

});

async function invoke(cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(argv, { cwd, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

async function writePresets(path: string, presets: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ presets })}\n`);
}

function preset(guidance: string, agent: Record<string, unknown>): { guidance: string; agent: Record<string, unknown> } {
  return { guidance, agent };
}

async function withProcessHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}
