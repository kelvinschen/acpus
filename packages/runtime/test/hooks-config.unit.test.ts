import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { validateHooksFile } from "../src/hooks/config.js";
import { loadHooksConfig, loadHooksConfigScopes } from "../src/hooks/loader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("hooks config", () => {
  it("accepts event-map command hooks", () => {
    const result = validateHooksFile({
      "run.completed": [{ id: "notify", match: { workflow: "^release" }, command: "./notify.sh", timeout: "30s" }],
      "node.failed": [{ match: { nodeId: "^(build|test)$", nodeKey: "build~", kind: "task|agent" }, command: "./alert.sh" }],
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toMatchObject({
      "run.completed": [{ id: "notify", command: "./notify.sh" }],
      "node.failed": [{ command: "./alert.sh" }],
    });
  });

  it("rejects wrapper fields, invalid run node matchers, and invalid regex", () => {
    const result = validateHooksFile({
      hooks: {},
      "run.completed": [{ command: "echo ok", match: { nodeId: "build", workflow: "[" } }],
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.getOrThrow(Result.flip(result))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.hooks" }),
      expect.objectContaining({ path: "$.run.completed[0].match.nodeId" }),
      expect.objectContaining({ path: "$.run.completed[0].match.workflow" }),
    ]));
  });

  it("rejects non-array event values", () => {
    const result = validateHooksFile({ "run.completed": { command: "echo ok" } });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.getOrThrow(Result.flip(result))).toEqual([expect.objectContaining({ path: "$.run.completed" })]);
  });

  it("rejects unknown hook and match fields", () => {
    const result = validateHooksFile({
      "node.completed": [{ command: "echo ok", unknown: true, match: { extra: ".*" } }],
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.getOrThrow(Result.flip(result))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.node.completed[0].unknown" }),
      expect.objectContaining({ path: "$.node.completed[0].match.extra" }),
    ]));
  });

  it("rejects empty id, empty command, and invalid timeout", () => {
    const result = validateHooksFile({
      "run.completed": [{ id: "", command: "", timeout: "soon" }],
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.getOrThrow(Result.flip(result))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.run.completed[0].id" }),
      expect.objectContaining({ path: "$.run.completed[0].command" }),
      expect.objectContaining({ path: "$.run.completed[0].timeout" }),
    ]));
  });

  it("accepts safe integer timeouts and rejects millisecond overflow", () => {
    expect(Result.isSuccess(validateHooksFile({
      "run.completed": [{ command: "echo ok", timeout: String(Number.MAX_SAFE_INTEGER) }],
    }))).toBe(true);

    const result = validateHooksFile({
      "run.completed": [{ command: "echo ok", timeout: "9007199254740992ms" }],
    });

    expect(Result.getOrThrow(Result.flip(result))).toEqual([
      expect.objectContaining({ path: "$.run.completed[0].timeout" }),
    ]);
  });

  it("rejects hook commands containing NUL bytes", () => {
    expect(Result.getOrThrow(Result.flip(validateHooksFile({
      "run.completed": [{ command: "echo\0broken" }],
    })))).toEqual([
      expect.objectContaining({ path: "$.run.completed[0].command" }),
    ]);
  });

  it("loads an empty object as no hooks", async () => {
    const workspace = await tempDir("hooks-empty-object-");
    const home = await tempDir("hooks-empty-object-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "config.json"), "{}");

    const loaded = await Effect.runPromise(Effect.result(loadHooksConfig(workspace, { homeDir: home })));

    expect(Result.isSuccess(loaded)).toBe(true);
    expect(Result.getOrThrow(loaded)).toEqual([]);
  });

  it("reports validation failures as invalid-config load errors", async () => {
    const workspace = await tempDir("hooks-invalid-config-");
    const home = await tempDir("hooks-invalid-config-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "config.json"), JSON.stringify({ hooks: { "run.completed": [{ command: "" }] } }));

    const loaded = await Effect.runPromise(Effect.result(loadHooksConfig(workspace, { homeDir: home })));

    expect(Result.isFailure(loaded)).toBe(true);
    expect(Result.getOrThrow(Result.flip(loaded))).toMatchObject({ type: "invalid-config", source: "project" });
  });

  it("rejects Hooks consumption when another config section is invalid", async () => {
    const workspace = await tempDir("hooks-invalid-agent-section-");
    const home = await tempDir("hooks-invalid-agent-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "config.json"), JSON.stringify({
      agents: { broken: "" },
      hooks: { "run.completed": [{ command: "echo must-not-load" }] },
    }));

    expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(loadHooksConfig(workspace, { homeDir: home }))))))).toMatchObject({
      type: "invalid-config",
      source: "project",
    });
  });

  it("allows signal identity matchers on run.awaiting", () => {
    const result = validateHooksFile({
      "run.awaiting": [{ command: "echo ok", match: { nodeId: "approve", nodeKey: "approve~", kind: "signal" } }],
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("loads project and global hooks by direct union without id override", async () => {
    const workspace = await tempDir("hooks-workspace-");
    const home = await tempDir("hooks-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await mkdir(join(home, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "config.json"), JSON.stringify({ hooks: {
      "run.completed": [
        { id: "same", command: "echo project" },
        { id: "same", command: "echo project again" },
      ],
    } }));
    await writeFile(join(home, ".acpus", "config.json"), JSON.stringify({ hooks: {
      "run.completed": [{ id: "same", command: "echo global" }],
    } }));

    const loaded = await Effect.runPromise(Effect.result(loadHooksConfig(workspace, { homeDir: home })));

    expect(Result.isSuccess(loaded)).toBe(true);
    expect(Result.getOrThrow(loaded)).toMatchObject([
      { source: "project", id: "same", command: "echo project", definitionIndex: 0 },
      { source: "project", id: "same", command: "echo project again", definitionIndex: 1 },
      { source: "global", id: "same", command: "echo global", definitionIndex: 0 },
    ]);
  });

  it("assigns readable default ids from source, event, and index", async () => {
    const workspace = await tempDir("hooks-default-id-");
    const home = await tempDir("hooks-default-id-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "config.json"), JSON.stringify({ hooks: {
      "node.failed": [{ command: "echo first" }, { command: "echo second" }],
    } }));

    const loaded = await Effect.runPromise(Effect.result(loadHooksConfig(workspace, { homeDir: home })));

    expect(Result.getOrThrow(loaded).map(hook => hook.effectiveId)).toEqual([
      "project:node.failed:0",
      "project:node.failed:1",
    ]);
  });

  it("returns empty scoped configs for missing files", async () => {
    const workspace = await tempDir("hooks-empty-workspace-");
    const home = await tempDir("hooks-empty-home-");

    const loaded = await Effect.runPromise(Effect.result(loadHooksConfigScopes(workspace, { homeDir: home })));

    expect(Result.isSuccess(loaded)).toBe(true);
    expect(Result.getOrThrow(loaded)).toEqual([
      { source: "project", path: join(workspace, ".acpus", "config.json"), hooks: [] },
      { source: "global", path: join(home, ".acpus", "config.json"), hooks: [] },
    ]);
  });

  it("reports invalid JSON as a load error", async () => {
    const workspace = await tempDir("hooks-invalid-json-");
    const home = await tempDir("hooks-invalid-home-");
    await mkdir(join(workspace, ".acpus"), { recursive: true });
    await writeFile(join(workspace, ".acpus", "config.json"), "{");

    const loaded = await Effect.runPromise(Effect.result(loadHooksConfig(workspace, { homeDir: home })));

    expect(Result.isFailure(loaded)).toBe(true);
    expect(Result.getOrThrow(Result.flip(loaded))).toMatchObject({ type: "invalid-config", source: "project" });
  });
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
