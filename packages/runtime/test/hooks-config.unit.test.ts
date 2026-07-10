import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateHooksFile } from "../src/hooks/config.js";
import { loadHooksConfig, loadHooksConfigScopes } from "../src/hooks/loader.js";
import { stableJson } from "../src/stable-json.js";

describe("hooks config", () => {
  it("accepts event-map command hooks", () => {
    const result = validateHooksFile({
      "run.completed": [{ id: "notify", match: { workflow: "^release" }, command: "./notify.sh", timeout: "30s" }],
      "node.failed": [{ match: { nodeId: "^(build|test)$", nodeKey: "build~", kind: "task|agent" }, command: "./alert.sh" }],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      "run.completed": [{ id: "notify", command: "./notify.sh" }],
      "node.failed": [{ command: "./alert.sh" }],
    });
  });

  it("rejects wrapper fields, invalid run node matchers, and invalid regex", () => {
    const result = validateHooksFile({
      hooks: {},
      "run.completed": [{ command: "echo ok", match: { nodeId: "build", workflow: "[" } }],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.hooks" }),
      expect.objectContaining({ path: "$.run.completed[0].match.nodeId" }),
      expect.objectContaining({ path: "$.run.completed[0].match.workflow" }),
    ]));
  });

  it("rejects non-array event values", () => {
    const result = validateHooksFile({ "run.completed": { command: "echo ok" } });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual([expect.objectContaining({ path: "$.run.completed" })]);
  });

  it("rejects unknown hook and match fields", () => {
    const result = validateHooksFile({
      "node.completed": [{ command: "echo ok", unknown: true, match: { extra: ".*" } }],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.node.completed[0].unknown" }),
      expect.objectContaining({ path: "$.node.completed[0].match.extra" }),
    ]));
  });

  it("rejects empty id, empty command, and invalid timeout", () => {
    const result = validateHooksFile({
      "run.completed": [{ id: "", command: "", timeout: "soon" }],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.run.completed[0].id" }),
      expect.objectContaining({ path: "$.run.completed[0].command" }),
      expect.objectContaining({ path: "$.run.completed[0].timeout" }),
    ]));
  });

  it("accepts safe integer timeouts and rejects millisecond overflow", () => {
    expect(validateHooksFile({
      "run.completed": [{ command: "echo ok", timeout: String(Number.MAX_SAFE_INTEGER) }],
    }).isOk()).toBe(true);

    const result = validateHooksFile({
      "run.completed": [{ command: "echo ok", timeout: "9007199254740992ms" }],
    });

    expect(result._unsafeUnwrapErr()).toEqual([
      expect.objectContaining({ path: "$.run.completed[0].timeout" }),
    ]);
  });

  it("rejects hook commands containing NUL bytes", () => {
    expect(validateHooksFile({
      "run.completed": [{ command: "echo\0broken" }],
    })._unsafeUnwrapErr()).toEqual([
      expect.objectContaining({ path: "$.run.completed[0].command" }),
    ]);
  });

  it("loads an empty object as no hooks", async () => {
    const workspace = await tempDir("hooks-empty-object-");
    const home = await tempDir("hooks-empty-object-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "hooks.json"), "{}");

    const loaded = await loadHooksConfig(workspace, { homeDir: home });

    expect(loaded.isOk()).toBe(true);
    expect(loaded._unsafeUnwrap()).toEqual([]);
  });

  it("reports validation failures as invalid-config load errors", async () => {
    const workspace = await tempDir("hooks-invalid-config-");
    const home = await tempDir("hooks-invalid-config-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "hooks.json"), JSON.stringify({ "run.completed": [{ command: "" }] }));

    const loaded = await loadHooksConfig(workspace, { homeDir: home });

    expect(loaded.isErr()).toBe(true);
    expect(loaded._unsafeUnwrapErr()).toMatchObject({ type: "invalid-config", source: "project" });
  });

  it("allows signal identity matchers on run.awaiting", () => {
    const result = validateHooksFile({
      "run.awaiting": [{ command: "echo ok", match: { nodeId: "approve", nodeKey: "approve~", kind: "signal" } }],
    });

    expect(result.isOk()).toBe(true);
  });

  it("loads project and global hooks by direct union without id override", async () => {
    const workspace = await tempDir("hooks-workspace-");
    const home = await tempDir("hooks-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await mkdir(join(home, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [
        { id: "same", command: "echo project" },
        { id: "same", command: "echo project again" },
      ],
    }));
    await writeFile(join(home, ".acpus", "hooks.json"), JSON.stringify({
      "run.completed": [{ id: "same", command: "echo global" }],
    }));

    const loaded = await loadHooksConfig(workspace, { homeDir: home });

    expect(loaded.isOk()).toBe(true);
    expect(loaded._unsafeUnwrap()).toMatchObject([
      { source: "project", id: "same", command: "echo project", definitionIndex: 0 },
      { source: "project", id: "same", command: "echo project again", definitionIndex: 1 },
      { source: "global", id: "same", command: "echo global", definitionIndex: 0 },
    ]);
    const hooks = loaded._unsafeUnwrap();
    expect(new Set(hooks.map(hook => hook.definitionHash)).size).toBe(3);
    expect(hooks[0]?.definitionHash).toBe(createHash("sha256").update(stableJson({
      source: "project",
      sourcePath: join(workspace, ".acpus", "hooks.json"),
      event: "run.completed",
      definitionIndex: 0,
      config: { id: "same", command: "echo project" },
    })).digest("hex"));
  });

  it("returns empty scoped configs for missing files", async () => {
    const workspace = await tempDir("hooks-empty-workspace-");
    const home = await tempDir("hooks-empty-home-");

    const loaded = await loadHooksConfigScopes(workspace, { homeDir: home });

    expect(loaded.isOk()).toBe(true);
    expect(loaded._unsafeUnwrap()).toEqual([
      { source: "project", path: join(workspace, ".acpus", "hooks.json"), hooks: [] },
      { source: "global", path: join(home, ".acpus", "hooks.json"), hooks: [] },
    ]);
  });

  it("reports invalid JSON as a load error", async () => {
    const workspace = await tempDir("hooks-invalid-json-");
    const home = await tempDir("hooks-invalid-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "hooks.json"), "{");

    const loaded = await loadHooksConfig(workspace, { homeDir: home });

    expect(loaded.isErr()).toBe(true);
    expect(loaded._unsafeUnwrapErr()).toMatchObject({ type: "invalid-json", source: "project" });
  });
});

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
