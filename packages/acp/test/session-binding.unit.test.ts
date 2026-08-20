import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSessionBindingMismatchCategories,
  resolveAgentSessionBinding,
} from "../src/session-binding.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Agent Session binding", () => {
  it("preserves the resolved launch values, drops the display name, and sorts options", async () => {
    const root = await scratch();
    await expect(resolveAgentSessionBinding({
      launch: { kind: "command", command: "custom-agent --acp", name: "ignored" },
      cwd: root,
      configuration: { model: "gpt-5", options: { z: "2", a: "1" } },
    })).resolves.toEqual({
      launch: { kind: "command", command: "custom-agent --acp" },
      cwd: root,
      model: "gpt-5",
      options: { a: "1", z: "2" },
    });
  });

  it("is invariant to option insertion order and launch display name", async () => {
    const root = await scratch();
    const left = await resolveAgentSessionBinding({
      launch: { kind: "argv", argv: ["agent", "--stdio"], name: "selector-a" },
      cwd: root,
      configuration: { model: null, options: { z: "2", a: "1" } },
    });
    const right = await resolveAgentSessionBinding({
      launch: { kind: "argv", argv: ["agent", "--stdio"], name: "selector-b" },
      cwd: root,
      configuration: { model: null, options: { a: "1", z: "2" } },
    });
    expect(left).toEqual(right);
    expect(agentSessionBindingMismatchCategories(left, right)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("uses the cwd realpath", async () => {
    const root = await scratch();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    const input = {
      launch: { kind: "argv", argv: ["agent"] } as const,
      configuration: { model: null, options: {} },
    };
    expect(await resolveAgentSessionBinding({ ...input, cwd: alias }))
      .toEqual(await resolveAgentSessionBinding({ ...input, cwd: actual }));
  });

  it("reports mismatches in fixed category order", async () => {
    const root = await scratch();
    const left = await resolveAgentSessionBinding({
      launch: { kind: "command", command: "agent-a" },
      cwd: root,
      configuration: { model: "model-a", options: { mode: "a" } },
    });
    const right = {
      launch: { kind: "command", command: "agent-b" } as const,
      cwd: `${root}-other`,
      model: "model-b",
      options: { mode: "b" },
    };
    expect(agentSessionBindingMismatchCategories(left, right))
      .toEqual(["launch", "cwd", "model", "options"]);
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-binding-"));
  roots.push(root);
  return root;
}
