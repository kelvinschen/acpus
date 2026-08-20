import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (path: Parameters<typeof actual.realpath>[0], options?: Parameters<typeof actual.realpath>[1]) =>
      path === "/workspace/acpus" ? Promise.resolve(path) : actual.realpath(path, options as never),
  };
});

import { fingerprintAgentSessionBinding } from "../src/session-binding.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Agent Session binding fingerprint", () => {
  it.each([
    {
      name: "argv",
      launch: { kind: "argv", argv: ["npx", "-y", "@agentclientprotocol/codex-acp@^1.1.5"], name: "ignored" } as const,
      configuration: { model: null, options: {} },
      digest: "sha256:516c213146702cd6e48d5151de13f4c5af913e52f79b950916e083e0e9cfc37c",
      components: {
        launch: "sha256:9c52113c2817124fb86abe0758ca777330153a7387051b9065493dc04ae3c05a",
        cwd: "sha256:71b2b39afc1703b0b3c23addaf27b85b98bc284de6939732229edc33d8cf3e9b",
        model: "sha256:dce6d5eac40e72efa0f166c2cb8ad3c46894c579ef421aadc41c288a40b15dc6",
        options: "sha256:0a58513fe84e3da3d97373e1e9a7b39ac1d584af53a89494028a977859e8b11b",
      },
    },
    {
      name: "command",
      launch: { kind: "command", command: "custom-agent --acp", name: "ignored" } as const,
      configuration: { model: "gpt-5", options: { z: "2", a: "1" } },
      digest: "sha256:d2cfccf46ce7ca7cdd74c009c248e75add4e2aabb891bf6f79e724b3e4b4e2cb",
      components: {
        launch: "sha256:780e89f8558554f19e431bb4401b341c0e72221f8284c82d43c7cf083f540c47",
        cwd: "sha256:71b2b39afc1703b0b3c23addaf27b85b98bc284de6939732229edc33d8cf3e9b",
        model: "sha256:61caa50b0b580a2a65c120279eebee2f2e03f38a2427b7a279248ac23a13a685",
        options: "sha256:4d8e772788c9b1bb5112a6695444d81b0d9fff2319c8862664c2707be82f1da5",
      },
    },
    {
      name: "numeric option keys",
      launch: { kind: "command", command: "custom-agent --acp" } as const,
      configuration: { model: "gpt-5", options: { "10": "ten", "2": "two", a: "aye" } },
      digest: "sha256:55e9c794edc9ae557d837752b356fc122ca8a06d94676f42ed9fc59c681c3357",
      components: {
        launch: "sha256:780e89f8558554f19e431bb4401b341c0e72221f8284c82d43c7cf083f540c47",
        cwd: "sha256:71b2b39afc1703b0b3c23addaf27b85b98bc284de6939732229edc33d8cf3e9b",
        model: "sha256:61caa50b0b580a2a65c120279eebee2f2e03f38a2427b7a279248ac23a13a685",
        options: "sha256:8b8dc22f849b1c72025112491c5bc2f7e20435d218676a4ca6a1e7edadc926f1",
      },
    },
  ])("matches the frozen $name golden vector", async ({ launch, configuration, digest, components }) => {
    await expect(fingerprintAgentSessionBinding({
      launch,
      cwd: "/workspace/acpus",
      configuration,
    })).resolves.toEqual({ version: 1, digest, components });
  });

  it("is invariant to option insertion order and launch display name", async () => {
    const left = await fingerprintAgentSessionBinding({
      launch: { kind: "command", command: "custom-agent --acp", name: "selector-a" },
      cwd: "/workspace/acpus",
      configuration: { model: "gpt-5", options: { "2": "two", a: "aye", "10": "ten" } },
    });
    const right = await fingerprintAgentSessionBinding({
      launch: { kind: "command", command: "custom-agent --acp", name: "selector-b" },
      cwd: "/workspace/acpus",
      configuration: { model: "gpt-5", options: { a: "aye", "10": "ten", "2": "two" } },
    });
    expect(left).toEqual(right);
  });

  it.skipIf(process.platform === "win32")("uses the cwd realpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-binding-"));
    roots.push(root);
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    const input = {
      launch: { kind: "argv", argv: ["agent"] } as const,
      configuration: { model: null, options: {} },
    };
    expect(await fingerprintAgentSessionBinding({ ...input, cwd: alias }))
      .toEqual(await fingerprintAgentSessionBinding({ ...input, cwd: actual }));
  });

  it.each([
    { name: "undefined", value: undefined },
    { name: "symbol", value: Symbol("x") },
    { name: "bigint", value: 1n },
    { name: "non-finite number", value: Number.POSITIVE_INFINITY },
  ])("rejects an out-of-domain $name option", async ({ value }) => {
    await expect(fingerprintAgentSessionBinding({
      launch: { kind: "argv", argv: ["agent"] },
      cwd: "/workspace/acpus",
      configuration: { model: null, options: { invalid: value } as unknown as Record<string, string> },
    })).rejects.toThrow(TypeError);
  });
});
