import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentProfileStore,
  effectiveAgentProfiles,
  renderAgentCatalog,
  type AgentProfile,
} from "../src/host/agent-profiles.js";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("DSH Agent Profile Store", () => {
  it("persists full set/remove changes without config", async () => {
    const { path, store } = await createStore();
    await expect(store.read()).resolves.toEqual([]);

    await expect(store.update({
      changes: [{
        operation: "set",
        profile: {
          id: " Codex_Deep ",
          use: " @OpenClaw/Codex.Agent ",
          model: " gpt-5.6-sol ",
          guidance: " Complex implementation and review. ",
        },
      }],
    })).resolves.toEqual({ status: "applied" });
    const persistedProfile = {
      id: "codex_deep",
      use: "@OpenClaw/Codex.Agent",
      model: "gpt-5.6-sol",
      guidance: "Complex implementation and review.",
    };
    await expect(new AgentProfileStore(path).read()).resolves.toEqual([persistedProfile]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      kind: "acpus_dsh_agent_profiles",
      version: 1,
      profiles: [persistedProfile],
    });

    await expect(store.update({
      changes: [{ operation: "remove", id: "codex_deep" }],
    })).resolves.toEqual({ status: "applied" });
    await expect(store.read()).resolves.toEqual([]);
  });

  it("applies sequential changes to the latest catalog state", async () => {
    const { store } = await createStore();

    await expect(store.update({
      changes: [{ operation: "set", profile: profile(0) }],
    })).resolves.toEqual({ status: "applied" });
    await expect(store.update({
      changes: [{ operation: "set", profile: profile(1) }],
    })).resolves.toEqual({ status: "applied" });
    const replacement = { ...profile(0), guidance: "Replacement role" };
    await expect(store.update({
      changes: [{ operation: "set", profile: replacement }],
    })).resolves.toEqual({ status: "applied" });

    await expect(store.read()).resolves.toEqual([replacement, profile(1)]);
  });

  it("accepts exactly 50 Profiles and atomically rejects the 51st", async () => {
    const { store } = await createStore();
    const profiles = Array.from({ length: 50 }, (_, index) => profile(index));
    await expect(store.update({
      changes: profiles.map(candidate => ({ operation: "set" as const, profile: candidate })),
    })).resolves.toEqual({ status: "applied" });
    await expect(store.update({
      changes: [{ operation: "set", profile: profile(50) }],
    })).resolves.toEqual({ status: "rejected", reason: "profile-limit" });
    await expect(store.read()).resolves.toEqual(profiles);
  });

  it("rejects partial, config-bearing, and missing changes without partial writes", async () => {
    const { store } = await createStore();
    await expect(store.update({
      changes: [
        { operation: "set", profile: profile(0) },
        {
          operation: "set",
          profile: { id: "bad", use: "agent", guidance: "Bad", config: {} },
        } as never,
      ],
    })).resolves.toEqual({ status: "rejected", reason: "invalid-profile" });
    await expect(store.update({
      changes: [{ operation: "remove", id: "missing" }],
    })).resolves.toEqual({ status: "rejected", reason: "profile-not-found" });
    await expect(store.read()).resolves.toEqual([]);
  });

  it("reserves the built-in dsh Profile", async () => {
    const { store } = await createStore();

    await expect(store.update({
      changes: [{
        operation: "set",
        profile: { id: "DSH", use: "other-agent", guidance: "Shadow DSH." },
      }],
    })).resolves.toEqual({ status: "rejected", reason: "invalid-profile" });
    await expect(store.update({
      changes: [{ operation: "remove", id: "dsh" }],
    })).resolves.toEqual({ status: "rejected", reason: "invalid-profile" });
    await expect(store.read()).resolves.toEqual([]);
  });

  it("rejects the removed nested Profile file shape", async () => {
    const { path } = await createStore();
    await writeFile(path, `${JSON.stringify({
      kind: "acpus_dsh_agent_profiles",
      version: 1,
      profiles: [{ id: "codex", definition: { use: "codex" }, guidance: "Coding." }],
    })}\n`);
    await expect(new AgentProfileStore(path).read()).rejects.toMatchObject({
      code: "ACPUS_AGENT_PROFILES_INVALID",
    });
  });

  it("renders compact selection guidance for prompt assembly", () => {
    const rendered = renderAgentCatalog([profile(0)]);
    const profiles = JSON.parse(rendered.split("\n").find(line => line.startsWith("["))!);

    expect(rendered).not.toContain("Revision");
    expect(profiles).toEqual([
      {
        id: "dsh",
        use: "dsh",
        guidance: expect.any(String),
      },
      profile(0),
    ]);
  });

  it("projects the built-in Profile before user storage order", () => {
    const profiles = effectiveAgentProfiles([
      profile(1),
      { ...profile(0), model: "model-0" },
    ]);

    expect(profiles).toEqual([
      {
        id: "dsh",
        use: "dsh",
        guidance: expect.any(String),
      },
      profile(1),
      { ...profile(0), model: "model-0" },
    ]);
  });

  it("rolls memory back when an atomic write fails", async () => {
    root = await mkdtemp(join(tmpdir(), "acpus-dsh-profiles-write-"));
    const parent = join(root, "profile-state");
    const path = join(parent, "agent-profiles.json");
    await mkdir(parent);
    const store = new AgentProfileStore(path);
    await store.read();
    await rm(parent, { recursive: true });
    await writeFile(parent, "blocker\n");
    await expect(store.update({
      changes: [{ operation: "set", profile: profile(0) }],
    })).rejects.toBeDefined();
    await expect(store.read()).resolves.toEqual([]);
  });
});

function profile(index: number): AgentProfile {
  return {
    id: `agent_${index}`,
    use: `agent_${index}`,
    guidance: `Role ${index}`,
  };
}

async function createStore(): Promise<{ path: string; store: AgentProfileStore }> {
  root = await mkdtemp(join(tmpdir(), "acpus-dsh-profiles-"));
  await mkdir(root, { recursive: true });
  const path = join(root, "agent-profiles.json");
  return { path, store: new AgentProfileStore(path) };
}
