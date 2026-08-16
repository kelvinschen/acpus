import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import Loader from "@deepseek-ai/cordis-plugin-loader";
import { scanRoot } from "@deepseek-ai/dsh-agent-presets";
import AcpusMode, {
  AcpusMode as NamedAcpusMode,
  AcpusPresetCollisionError,
  installAcpusPreset,
  uninstallAcpusPreset,
} from "@acpus/dsh";
import * as host from "@acpus/dsh";
import * as client from "@acpus/dsh/client";
import type * as projection from "@acpus/dsh/projection";
import remote from "@acpus/dsh/remote";
import * as supervisor from "@acpus/dsh/supervisor";

const packageRoot = new URL("../", import.meta.url);

describe("@acpus/dsh public contract", () => {
  it("publishes Loader-safe Host, Supervisor, projection, Remote, and Client entry points", () => {
    const loader = Object.create(Loader.prototype) as Loader;

    expect(Object.keys(host).sort()).toEqual([
      "AcpusMode",
      "AcpusPresetCollisionError",
      "default",
      "installAcpusPreset",
      "uninstallAcpusPreset",
    ]);
    expect(AcpusMode).toBe(NamedAcpusMode);
    expect(typeof installAcpusPreset).toBe("function");
    expect(typeof uninstallAcpusPreset).toBe("function");
    expect(AcpusPresetCollisionError.name).toBe("AcpusPresetCollisionError");
    expect(loader.unwrapExports(supervisor)).toBe(supervisor);
    expect(supervisor.inject).toEqual(["tools", "systemPrompt"]);
    expect(client.inject).toEqual(["slots", "remote"]);
    expect(typeof client.AcpusActivityTray).toBe("function");
    expect(typeof client.AcpusInternalToolView).toBe("function");
    expect(typeof client.AcpusProfileAction).toBe("function");
    expect(remote.package).toBe("@acpus/dsh");
    expect(remote.descriptors.map(descriptor => descriptor.method).sort()).toEqual([
      "awaitSessionActivityRevision",
      "cancelSessionTask",
      "readActivityDetail",
      "readAgentProfiles",
      "readSessionActivity",
    ]);
    expect(remote.descriptors.find(descriptor =>
      descriptor.method === "awaitSessionActivityRevision"
    )?.cancellation).toEqual({ parameter: "signal" });
    expect(null as projection.SessionActivityProjection | null).toBeNull();
  });

  it("publishes a selector-independent revision invalidation Remote", () => {
    const descriptor = remote.descriptors.find(candidate =>
      candidate.method === "awaitSessionActivityRevision"
    );
    const parameter = descriptor?.parameters[0];
    if (parameter?.source !== "json" || parameter.codec.mode !== "strict"
      || descriptor?.result.mode !== "strict") {
      throw new Error("Expected strict revision wait codecs.");
    }

    expect(parameter.codec.schema.parse({
      sessionId: "session-1",
      afterRevision: 4,
      task: { name: "private-selection", occurrence: 1 },
    })).toEqual({ sessionId: "session-1", afterRevision: 4 });
    expect(descriptor.result.schema.parse({
      revision: 5,
      unchanged: false,
      projection: { sessionId: "session-1" },
    })).toEqual({ revision: 5 });
  });

  it("ships the fifth complete Supervisor preset with only the Acpus plugin row", async () => {
    const [manifestSource, metadata, composition, bundle, discovered] = await Promise.all([
      readFile(new URL("package.json", packageRoot), "utf8"),
      readFile(new URL("preset/acpus/preset.yml", packageRoot), "utf8"),
      readFile(new URL("preset/acpus/agent.cordis.yml", packageRoot), "utf8"),
      readFile(new URL("cordis.patch.yml", packageRoot), "utf8"),
      scanRoot({
        path: fileURLToPath(new URL("preset/", packageRoot)),
        trust: "system",
      }),
    ]);
    const manifest = JSON.parse(manifestSource);

    expect(metadata).toContain("name: Acpus 模式");
    expect(metadata).toContain("order: 5");
    expect(composition).toContain("complete: true");
    expect(composition).toContain("{{acpus_agents}}");
    expect(composition).toContain("name: '@acpus/dsh/supervisor'");
    expect(composition).not.toMatch(/dsh-tool-|dsh-subagent|dsh-workflow|dsh-skill/);
    expect(discovered).toEqual([
      expect.objectContaining({ id: "acpus", name: "Acpus 模式", order: 5 }),
    ]);
    expect(discovered[0]).not.toHaveProperty("broken");
    expect(manifest.dsh).toEqual({
      bundle: { patch: "./cordis.patch.yml" },
      client: {
        inject: [
          "@deepseek-ai/dsh-client-runtime",
          "@deepseek-ai/dsh-client-ui-conversation",
          "@deepseek-ai/dsh-client-ui-tool",
          "@deepseek-ai/dsh-api-remotes",
        ],
        platform: "web",
      },
    });
    expect(manifest.exports["./client"].default).toBe("./dist/client.js");
    expect(manifest.exports["./projection"].types).toBe("./dist/remote/types.d.ts");
    expect(manifest.exports["./remote"].default).toBe("./dist/typert.remote-client.js");
    expect(manifest.peerDependencies["@deepseek-ai/dsh-session"]).toBe("^0.1.0-rc.6");
    expect(manifest.dependencies).toMatchObject({
      "@deepseek-ai/dsh-acp": "0.1.0-rc.6",
      "@deepseek-ai/dsh-app-boot": "0.1.0-rc.6",
      "@deepseek-ai/dsh-base": "0.1.0-rc.6",
    });
    expect(manifest.files).toContain("acp-agent");
    expect(manifest.files).toContain("README.md");
    expect(bundle).toBe([
      "- insert:",
      "    - id: acpus-mode",
      "      name: '@acpus/dsh'",
      "",
    ].join("\n"));
  });

  it("mounts Remote, hides internal tools, and registers the activity tray", async () => {
    const calls: unknown[][] = [];
    const remoteDispose = vi.fn(async () => undefined);
    const effectDispose = vi.fn(async () => undefined);
    const ctx = {
      remote: {
        acpus: {},
        $mount: vi.fn(async (contribution: unknown) => {
          calls.push(["mount", contribution]);
          return remoteDispose;
        }),
      },
      get(name: string) {
        return name === "remote.acpus" ? this.remote.acpus : undefined;
      },
      effect(callback: () => (() => void), label: string) {
        calls.push(["effect", label]);
        const dispose = callback();
        return async () => {
          dispose();
          await effectDispose();
        };
      },
      slots: {
        inject(name: string, register: () => unknown) {
          calls.push(["inject", name]);
          return register() as () => void;
        },
        register(options: unknown, value: unknown) {
          calls.push(["register", options, value]);
          return () => {};
        },
      },
    };

    const dispose = await client.apply(ctx as unknown as Parameters<typeof client.apply>[0]);

    expect(calls[0]?.[0]).toBe("mount");
    expect(calls[0]?.[1]).toMatchObject({
      package: remote.package,
      descriptors: remote.descriptors.map(({ namespace, method }) => ({
        namespace,
        method,
      })),
    });
    expect(calls[1]).toEqual(["effect", "acpus.client"]);
    expect(calls.filter(([kind, name]) =>
      kind === "inject" && name === "tool.call.toolview"
    )).toHaveLength(6);
    expect(calls.filter(([kind]) => kind === "register").slice(0, 6)).toEqual(
      [
        "acpus_profiles",
        "acpus_tasks",
        "acpus_run",
        "acpus_inspect",
        "acpus_control",
        "acpus_artifact",
      ]
        .map(key => [
          "register",
          expect.objectContaining({ name: "tool.call.toolview", key }),
          client.AcpusInternalToolView,
        ]),
    );
    expect(calls).toContainEqual([
      "inject",
      "conversation.session.header.actions",
    ]);
    expect(calls).toContainEqual([
      "register",
      expect.objectContaining({
        name: "conversation.session.header.actions",
        id: "acpus-dsh-brand",
        order: -9,
      }),
      expect.any(Function),
    ]);
    expect(calls).toContainEqual([
      "register",
      expect.objectContaining({
        name: "conversation.session.header.actions",
        id: "acpus-agent-profiles",
        order: 0,
      }),
      client.AcpusProfileAction,
    ]);
    expect(calls.filter(([kind]) => kind === "register").at(-1)).toEqual([
      "register",
      expect.objectContaining({ name: "conversation.input.dock", id: "acpus-runs" }),
      client.AcpusActivityTray,
    ]);
    await dispose();
    expect(effectDispose).toHaveBeenCalledOnce();
    expect(remoteDispose).toHaveBeenCalledOnce();
  });

  it("publishes only the safe Agent Profile catalog fields", () => {
    const descriptor = remote.descriptors.find(candidate =>
      candidate.method === "readAgentProfiles"
    );
    const parameter = descriptor?.parameters[0];
    if (parameter?.source !== "json" || parameter.codec.mode !== "strict"
      || descriptor?.result.mode !== "strict") {
      throw new Error("Expected strict Agent Profile catalog codecs.");
    }

    expect(parameter.codec.schema.parse({ private: "ignored" })).toEqual({});
    const parsed = descriptor.result.schema.parse({
      profiles: [{
        id: "dsh",
        use: "dsh",
        guidance: "Built-in DSH.",
        builtIn: true,
        command: "private-command",
        env: { SECRET: "value" },
      }],
      revision: 4,
      stateDir: "/private/state",
    }) as projection.ReadAgentProfilesResult;

    expect(parsed).toEqual({
      profiles: [{
        id: "dsh",
        use: "dsh",
        guidance: "Built-in DSH.",
        builtIn: true,
      }],
    });
  });

  it("publishes task projections without Runtime or admission identities", () => {
    const descriptor = remote.descriptors.find(candidate =>
      candidate.method === "readSessionActivity"
    );
    expect(descriptor?.result.mode).toBe("strict");
    if (descriptor === undefined || descriptor.result.mode !== "strict") {
      throw new Error("Expected a strict readSessionActivity result codec.");
    }
    const parsed = descriptor.result.schema.parse({
      sessionId: "session-1",
      revision: 1,
      tasks: [],
      tasksTruncated: false,
      task: {
        selector: { name: "review", occurrence: 1 },
        generation: 1,
        status: "running",
        counts: {
          total: 1,
          notStarted: 0,
          pending: 0,
          running: 1,
          awaiting: 0,
          completed: 0,
          failed: 0,
          timedOut: 0,
          canceled: 0,
        },
        startedAt: "2026-08-14T00:00:00.000Z",
        tree: [{
          activityId: "0123456789abcdef0123456789abcdef",
          label: "Review",
          kind: "agent",
          status: "running",
          startedAt: "2026-08-14T00:00:00.000Z",
          agent: {
            name: "codex",
            phase: "tool",
            turn: 1,
            tool: { name: "Read", title: "Read the configuration", state: "running" },
            telemetry: {
              inputTokens: 12_000,
              outputTokens: 2_400,
              totalTokens: 14_400,
              contextWindow: { used: 12_000, size: 32_000 },
            },
          },
          children: [],
        }],
      },
    }) as projection.SessionActivityProjection;

    expect(parsed.task).not.toHaveProperty("runId");
    expect(parsed.task).not.toHaveProperty("taskId");
    expect(parsed.task?.tree[0]).not.toHaveProperty("key");
    expect(parsed.task?.tree[0]).not.toHaveProperty("target");
    expect(extractAgent(parsed.task?.tree[0]).tool).toEqual({
      name: "Read",
      title: "Read the configuration",
      state: "running",
    });
    const sanitized = descriptor.result.schema.parse({
      ...parsed,
      task: {
        ...parsed.task!,
        tree: [{
          ...parsed.task!.tree[0],
          agent: {
            ...extractAgent(parsed.task!.tree[0]),
            telemetry: { cachedReadTokens: 1 },
          },
        }],
      },
    }) as projection.SessionActivityProjection;
    expect(extractAgent(sanitized.task?.tree[0]).telemetry)
      .not.toHaveProperty("cachedReadTokens");
  });

  it("publishes Task hover data without execution internals", () => {
    const descriptor = remote.descriptors.find(candidate =>
      candidate.method === "readActivityDetail"
    );
    expect(descriptor?.result.mode).toBe("strict");
    if (descriptor === undefined || descriptor.result.mode !== "strict") {
      throw new Error("Expected a strict readActivityDetail result codec.");
    }
    const parsed = descriptor.result.schema.parse({
      status: "available",
      detail: {
        kind: "task",
        input: { format: "json", text: '{"topic":"AI"}', truncated: false },
        result: { kind: "output", format: "text", text: "done", truncated: false },
        cwd: "/private/workspace",
        env: { SECRET: "value" },
        implementation: "inline source",
      },
    }) as projection.ReadActivityDetailResult;

    expect(parsed).toMatchObject({
      status: "available",
      detail: {
        kind: "task",
        input: { format: "json", text: '{"topic":"AI"}', truncated: false },
        result: { kind: "output", format: "text", text: "done", truncated: false },
      },
    });
    if (parsed.status !== "available") throw new Error("Expected available Task detail.");
    expect(parsed.detail).not.toHaveProperty("cwd");
    expect(parsed.detail).not.toHaveProperty("env");
    expect(parsed.detail).not.toHaveProperty("implementation");
  });
});

function extractAgent(node: projection.ActivityNode | undefined): projection.AgentActivity {
  return node?.agent ?? {};
}
