import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok, ResultAsync } from "neverthrow";
import {
  addAgentPreset,
  applyAgentPresetChanges,
  loadAcpusConfigScope,
  loadAgentPresetCatalog,
  projectAcpusConfigPath,
  removeAgentPreset,
  resolveConfiguredAgentCommand,
} from "../src/index.js";
import { captureProcessIdentity } from "../src/process-liveness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Agent Preset catalog", () => {
  it("loads one strict config with normalized Agents, Presets, and Hooks", async () => {
    const root = await temporaryRoot();
    const path = projectAcpusConfigPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      agents: { " Custom-Agent ": "  custom-acp --stdio  " },
      presets: { reviewer: { guidance: "Review", agent: { use: "custom-agent" } } },
      hooks: { "run.completed": [{ command: "echo done" }] },
    }));

    const loaded = await loadAcpusConfigScope({ workspaceDir: root, scope: "project" });

    expect(loaded._unsafeUnwrap()).toEqual({
      agents: { "custom-agent": "  custom-acp --stdio  " },
      presets: { reviewer: { guidance: "Review", agent: { use: "custom-agent" } } },
      hooks: { "run.completed": [{ command: "echo done" }] },
    });
  });

  it.each([
    ["unknown top-level field", { unknown: true }],
    ["invalid Agents", { agents: { broken: "" } }],
    ["normalized Agent collision", { agents: { Agent: "one", " agent ": "two" } }],
    ["invalid Preset", { presets: { reviewer: { guidance: "", agent: { use: "codex" } } } }],
    ["invalid Hooks", { hooks: { "run.completed": [{ command: "" }] } }],
  ])("rejects the whole config for %s", async (_case, config) => {
    const root = await temporaryRoot();
    const path = projectAcpusConfigPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config));

    expect((await loadAcpusConfigScope({ workspaceDir: root, scope: "project" }))._unsafeUnwrapErr()).toMatchObject({
      type: "acpus-config-invalid",
      source: "project",
      path,
    });
  });

  it("resolves configured Agents by project then global and Preset writes preserve other sections", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const homeDir = join(root, "home");
    const projectPath = projectAcpusConfigPath(workspace);
    const globalPath = join(homeDir, ".acpus", "config.json");
    await Promise.all([mkdir(dirname(projectPath), { recursive: true }), mkdir(dirname(globalPath), { recursive: true })]);
    await writeFile(projectPath, JSON.stringify({
      agents: { droid: "project-droid --stdio", worker: "project-worker --stdio" },
      hooks: { "run.completed": [{ command: "echo preserved" }] },
    }));
    await writeFile(globalPath, JSON.stringify({ agents: { factorydroid: "global-alias --stdio", worker: "global-worker --stdio", reviewer: "global-reviewer --stdio" } }));

    expect((await resolveConfiguredAgentCommand({ workspaceDir: workspace, homeDir, names: ["worker"] }))._unsafeUnwrap()).toBe("project-worker --stdio");
    expect((await resolveConfiguredAgentCommand({ workspaceDir: workspace, homeDir, names: ["reviewer"] }))._unsafeUnwrap()).toBe("global-reviewer --stdio");
    expect((await resolveConfiguredAgentCommand({ workspaceDir: workspace, homeDir, names: ["factorydroid", "droid"] }))._unsafeUnwrap()).toBe("project-droid --stdio");
    await writeFile(projectPath, JSON.stringify({
      agents: { droid: "project-droid --stdio", worker: "updated-project-worker --stdio" },
      hooks: { "run.completed": [{ command: "echo preserved" }] },
    }));
    expect((await resolveConfiguredAgentCommand({ workspaceDir: workspace, homeDir, names: ["worker"] }))._unsafeUnwrap()).toBe("updated-project-worker --stdio");
    await addAgentPreset({
      workspaceDir: workspace,
      scope: "project",
      id: "coder",
      preset: { guidance: "Code", agent: { use: "worker" } },
    });
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      agents: { droid: "project-droid --stdio", worker: "updated-project-worker --stdio" },
      presets: { coder: { guidance: "Code", agent: { use: "worker" } } },
      hooks: { "run.completed": [{ command: "echo preserved" }] },
    });
    expect((await removeAgentPreset({
      workspaceDir: workspace,
      scope: "project",
      id: "coder",
    })).isOk()).toBe(true);
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      agents: { droid: "project-droid --stdio", worker: "updated-project-worker --stdio" },
      hooks: { "run.completed": [{ command: "echo preserved" }] },
    });
    expect((await removeAgentPreset({
      workspaceDir: workspace,
      scope: "project",
      id: "coder",
    }))._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-missing", id: "coder" });
  });

  it("writes canonical section/key order while retaining Hook declaration order", async () => {
    const workspace = await temporaryRoot();
    const path = projectAcpusConfigPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      hooks: { "run.completed": [{ command: "echo first" }, { command: "echo second" }] },
      presets: { zed: { guidance: "Zed", agent: { use: "codex" } } },
      agents: { zed: "zed --stdio", alpha: "alpha --stdio" },
    }));

    expect((await addAgentPreset({
      workspaceDir: workspace,
      scope: "project",
      id: "alpha",
      preset: { guidance: "Alpha", agent: { use: "pi" } },
    })).isOk()).toBe(true);

    const serialized = await readFile(path, "utf8");
    const config = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(config)).toEqual(["agents", "presets", "hooks"]);
    expect(Object.keys(config.agents as object)).toEqual(["alpha", "zed"]);
    expect(Object.keys(config.presets as object)).toEqual(["alpha", "zed"]);
    expect(config.hooks).toEqual({
      "run.completed": [{ command: "echo first" }, { command: "echo second" }],
    });
  });

  it("keeps the safe selection surface and applies Host > project > global precedence", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const homeDir = join(root, "home");
    await writeCatalog(projectAcpusConfigPath(workspace), {
      reviewer: { guidance: "project", agent: { use: "project-agent" } },
    });
    await writeCatalog(join(homeDir, ".acpus", "config.json"), {
      reviewer: { guidance: "global", agent: { use: "global-agent" } },
      writer: { guidance: "write", agent: { command: "secret command" } },
    });

    const catalog = await loadAgentPresetCatalog({
      workspaceDir: workspace,
      homeDir,
      hostProvider: () => new ResultAsync(Promise.resolve(ok([
          { id: "reviewer", guidance: "host", agent: { use: "host-agent" } },
        ]))),
    });

    expect(catalog._unsafeUnwrap().choices).toEqual([
      { id: "reviewer", guidance: "host", scope: "host" },
      { id: "writer", guidance: "write", scope: "global" },
    ]);
    expect(catalog._unsafeUnwrap().resolve(["reviewer"])._unsafeUnwrap().reviewer?.definition).toMatchObject({
      kind: "agent_definition",
      use: "host-agent",
    });
  });

  it("uses canonical scope precedence regardless of requested scope order", async () => {
    const root = await temporaryRoot();
    await writeCatalog(join(root, ".acpus", "config.json"), {
      reviewer: { guidance: "global", agent: { use: "global-agent" } },
    });

    const catalog = await loadAgentPresetCatalog({
      homeDir: root,
      scopes: ["global", "host"],
      hostProvider: () => new ResultAsync(Promise.resolve(ok([
        { id: "reviewer", guidance: "host", agent: { use: "host-agent" } },
      ]))),
    });

    expect(catalog._unsafeUnwrap().choices).toEqual([{ id: "reviewer", guidance: "host", scope: "host" }]);
    expect(catalog._unsafeUnwrap().resolve(["reviewer"])._unsafeUnwrap().reviewer?.definition).toMatchObject({
      use: "host-agent",
    });
  });

  it("rejects unknown catalog and writable scopes", async () => {
    const root = await temporaryRoot();
    expect((await loadAgentPresetCatalog({
      homeDir: root,
      scopes: ["bogus" as any],
    }))._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-catalog-scope-invalid" });

    expect((await applyAgentPresetChanges({
      homeDir: root,
      scope: "bogus" as any,
      changes: [{ type: "set", id: "reviewer", preset: { guidance: "Review", agent: { use: "codex" } } }],
    }))._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-catalog-scope-invalid" });
    await expect(access(join(root, ".acpus", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects reserved ids and more than fifty entries", async () => {
    const root = await temporaryRoot();
    const reserved = await addAgentPreset({
      workspaceDir: root,
      scope: "project",
      id: "dsh",
      preset: { guidance: "reserved", agent: { use: "dsh" } },
    });
    expect(reserved._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-changes-invalid" });

    const tooMany = await applyAgentPresetChanges({
      workspaceDir: root,
      scope: "project",
      changes: Array.from({ length: 51 }, (_, index) => ({
        type: "set" as const,
        id: `agent-${index}`,
        preset: { guidance: `Agent ${index}`, agent: { use: "codex" } },
      })),
    });
    expect(tooMany._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-changes-invalid" });
  });

  it("serializes add races and returns a tagged busy lock failure", async () => {
    const root = await temporaryRoot();
    const input = {
      workspaceDir: root,
      scope: "project" as const,
      id: "reviewer",
      preset: { guidance: "Review", agent: { use: "codex" } },
    };
    const raced = await Promise.all([addAgentPreset(input), addAgentPreset(input)]);
    expect(raced.filter(result => result.isOk())).toHaveLength(1);
    expect(raced.filter(result => result.isErr()).map(result => result._unsafeUnwrapErr().type)).toEqual([
      expect.stringMatching(/^agent-preset-(busy|exists)$/),
    ]);

    const path = projectAcpusConfigPath(root);
    await writeFile(`${path}.lock`, "busy\n", { mode: 0o600 });
    const busy = await applyAgentPresetChanges({
      workspaceDir: root,
      scope: "project",
      changes: [{ type: "remove", id: "reviewer" }],
    });
    expect(busy._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-busy", path });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ presets: { reviewer: input.preset } });
  });

  it.skipIf(process.platform !== "linux")("recovers a lock only after proving its process identity is stale", async () => {
    const root = await temporaryRoot();
    const path = projectAcpusConfigPath(root);
    const identity = captureProcessIdentity();
    if (identity.startToken === undefined) throw new Error("Expected a Linux process start token.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, `${JSON.stringify({
      pid: identity.pid,
      startToken: `${identity.startToken}:reused`,
      token: "dead-owner",
    })}\n`, { mode: 0o600 });

    const added = await addAgentPreset({
      workspaceDir: root,
      scope: "project",
      id: "reviewer",
      preset: { guidance: "Review", agent: { use: "codex" } },
    });

    expect(added.isOk()).toBe(true);
    await expect(access(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a lock owned by the current live process busy", async () => {
    const root = await temporaryRoot();
    const path = projectAcpusConfigPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, `${JSON.stringify({
      ...captureProcessIdentity(),
      token: "live-owner",
    })}\n`, { mode: 0o600 });

    const added = await addAgentPreset({
      workspaceDir: root,
      scope: "project",
      id: "reviewer",
      preset: { guidance: "Review", agent: { use: "codex" } },
    });

    expect(added._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-busy" });
    expect(JSON.parse(await readFile(`${path}.lock`, "utf8"))).toMatchObject({ token: "live-owner" });
  });

  it("tightens an existing global catalog directory to owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const directory = join(root, ".acpus");
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o777);

    const added = await addAgentPreset({
      homeDir: root,
      scope: "global",
      id: "reviewer",
      preset: { guidance: "Review", agent: { use: "codex" } },
    });

    expect(added.isOk()).toBe(true);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("preserves opaque prototype-looking config keys in preset definitions", async () => {
    const root = await temporaryRoot();
    await writeCatalog(projectAcpusConfigPath(root), {
      reviewer: {
        guidance: "Review",
        agent: { use: "codex", config: Object.fromEntries([["__proto__", "kept"]]) },
      },
    });

    const catalog = await loadAgentPresetCatalog({ workspaceDir: root, scopes: ["project"] });
    const config = catalog._unsafeUnwrap().resolve(["reviewer"])._unsafeUnwrap().reviewer?.definition.config;
    expect(config && Object.hasOwn(config, "__proto__")).toBe(true);
    expect(config?.__proto__).toBe("kept");
  });

  it("rejects prototype-looking preset ids from file catalogs", async () => {
    const root = await temporaryRoot();
    await writeCatalog(projectAcpusConfigPath(root), Object.fromEntries([
      ["__proto__", { guidance: "Invalid", agent: { use: "codex" } }],
    ]));

    const catalog = await loadAgentPresetCatalog({ workspaceDir: root, scopes: ["project"] });
    expect(catalog._unsafeUnwrapErr()).toMatchObject({
      type: "acpus-config-invalid",
      source: "project",
    });
  });

  it("rejects a project preset directory symlink without writing outside the workspace", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await symlink(outside, join(workspace, ".acpus"), "dir");

    const added = await addAgentPreset({
      workspaceDir: workspace,
      scope: "project",
      id: "reviewer",
      preset: { guidance: "Review", agent: { use: "codex" } },
    });

    expect(added._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-write-failed", scope: "project" });
    await expect(access(join(outside, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not chmod an external directory through a global preset symlink", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const homeDir = join(root, "home");
    const outside = join(root, "outside");
    await Promise.all([mkdir(homeDir), mkdir(outside)]);
    await chmod(outside, 0o777);
    await symlink(outside, join(homeDir, ".acpus"), "dir");

    const added = await addAgentPreset({
      homeDir,
      scope: "global",
      id: "reviewer",
      preset: { guidance: "Review", agent: { use: "codex" } },
    });

    expect(added._unsafeUnwrapErr()).toMatchObject({ type: "agent-preset-write-failed", scope: "global" });
    expect((await stat(outside)).mode & 0o777).toBe(0o777);
    await expect(access(join(outside, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-agent-presets-"));
  roots.push(root);
  return root;
}

async function writeCatalog(path: string, presets: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ presets })}\n`, "utf8");
}
