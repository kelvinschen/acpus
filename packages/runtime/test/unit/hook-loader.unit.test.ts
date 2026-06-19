import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HookConfigLoader,
  mergeHookConfigs,
  hashHookConfig,
  isEmptyHookConfig,
  projectHookConfigPath
} from "../../src/hooks/loader.js";
import type { HookConfig } from "@acpus/core";

describe("HookConfigLoader", () => {
  let workspace: string;
  let originalHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "acpus-hooks-ws-"));
    fakeHome = mkdtempSync(join(tmpdir(), "acpus-hooks-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeProject(config: HookConfig): void {
    mkdirSync(join(workspace, ".acpus"), { recursive: true });
    writeFileSync(projectHookConfigPath(workspace), yamlForConfig(config), "utf8");
  }

  function writeProjectRaw(config: unknown): void {
    mkdirSync(join(workspace, ".acpus"), { recursive: true });
    writeFileSync(projectHookConfigPath(workspace), yamlForConfig(config), "utf8");
  }

  function writeGlobal(config: HookConfig): void {
    mkdirSync(join(fakeHome, ".acpus"), { recursive: true });
    writeFileSync(join(fakeHome, ".acpus", "hooks.yaml"), yamlForConfig(config), "utf8");
  }

  it("treats both absent layers as empty without error", () => {
    const loader = new HookConfigLoader(workspace);
    const snapshot = loader.freeze();
    expect(snapshot).toBeUndefined();
    expect(isEmptyHookConfig(loader.load().merged)).toBe(true);
  });

  it("merges global before project for the same key", () => {
    writeGlobal({ events: { afterRun: [{ command: "global.sh" }] } });
    writeProject({ events: { afterRun: [{ command: "project.sh" }] } });
    const { merged } = new HookConfigLoader(workspace).load();
    const cmds = (merged.events?.afterRun ?? []).map((h) => h.command);
    expect(cmds).toEqual(["global.sh", "project.sh"]);
  });

  it("freezes a snapshot with a stable hash and source paths", () => {
    writeGlobal({ injectors: { beforeAgentExec: [{ command: "g.sh" }] } });
    writeProject({ injectors: { beforeAgentExec: [{ command: "p.sh" }] } });
    const snapshot = new HookConfigLoader(workspace).freeze();
    expect(snapshot).toBeDefined();
    expect(snapshot!.hash.startsWith("sha256:")).toBe(true);
    expect(snapshot!.globalConfigPath).toContain(".acpus/hooks.yaml");
    expect(snapshot!.projectConfigPath).toBe(projectHookConfigPath(workspace));
  });

  it("hash is independent of object key ordering", () => {
    const a: HookConfig = { events: { afterRun: [{ command: "x", timeout: "5s" }] } };
    const b: HookConfig = { events: { afterRun: [{ timeout: "5s", command: "x" }] } };
    expect(hashHookConfig(a)).toBe(hashHookConfig(b));
  });

  it("returns empty config when files contain empty objects", () => {
    writeGlobal({});
    writeProject({});
    expect(new HookConfigLoader(workspace).freeze()).toBeUndefined();
  });

  it("mergeHookConfigs omits keys with no handlers", () => {
    const merged = mergeHookConfigs({}, {});
    expect(merged.injectors).toBeUndefined();
    expect(merged.events).toBeUndefined();
  });

  it("rejects non-object hook config roots", () => {
    for (const root of [[], "hooks", 42, null]) {
      writeProjectRaw(root);
      expect(() => new HookConfigLoader(workspace).load()).toThrow(/hook config must be an object/);
    }
  });

  it("rejects unknown hook names at load time", () => {
    writeProjectRaw({ events: { afterrun: [{ command: "x" }] } });
    expect(() => new HookConfigLoader(workspace).load()).toThrow(/unknown hook name 'afterrun'/);
  });

  it("rejects unsupported handler fields at load time", () => {
    writeProjectRaw({ events: { afterRun: [{ command: "x", extra: true }] } });
    expect(() => new HookConfigLoader(workspace).load()).toThrow(/extra is not supported/);
  });

  it("rejects invalid command handler field shapes at load time", () => {
    writeProjectRaw({ events: { afterRun: [{ command: "x", timeout: true }] } });
    expect(() => new HookConfigLoader(workspace).load()).toThrow(/timeout must be a string/);

    writeProjectRaw({ events: { afterRun: [{ command: "x", cwd: 123 }] } });
    expect(() => new HookConfigLoader(workspace).load()).toThrow(/cwd must be a string/);

    writeProjectRaw({ events: { afterRun: [{ command: "x", env: { OK: true } }] } });
    expect(() => new HookConfigLoader(workspace).load()).toThrow(/env must be a string map/);
  });
});

function yamlForConfig(config: unknown): string {
  return JSON.stringify(config);
}
