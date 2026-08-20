import { describe, expect, it } from "vitest";
import {
  finalizeAgentBindings,
  loadAgentPresetCatalog,
  tryParseAgentInjectionMap,
} from "../src/index.js";
import { parseFrozenAgentBindingMap, rebuildFrozenAgentBindings } from "../src/agents/injections.js";
import type { AgentDeclarationIR } from "@acpus/core/ir";
import { ok, ResultAsync } from "neverthrow";

describe("Agent binding finalization", () => {
  it("parses the direct-or-preset union strictly and rejects unknown declarations", () => {
    expect(tryParseAgentInjectionMap({ reviewer: { preset: "reviewer" } }, { reviewer: {} }).isOk()).toBe(true);
    expect(tryParseAgentInjectionMap({ reviewer: { use: "codex" } }, { reviewer: {} }).isOk()).toBe(true);
    expect(tryParseAgentInjectionMap({ reviewer: { preset: "reviewer", model: "gpt" } }, { reviewer: {} })._unsafeUnwrapErr()).toMatchObject({
      type: "agent-injections-invalid",
      reason: "schema",
    });
    expect(tryParseAgentInjectionMap({ missing: { use: "codex" } }, { reviewer: {} })._unsafeUnwrapErr()).toMatchObject({
      type: "agent-injections-invalid",
      reason: "unknown-agent",
      agentName: "missing",
    });
    expect(tryParseAgentInjectionMap({ reviewer: { use: "codex", cwd: "" } }, { reviewer: {} })._unsafeUnwrapErr()).toMatchObject({
      type: "agent-injections-invalid",
      reason: "schema",
      path: "$.reviewer.cwd",
    });
  });

  it("parses compact frozen bindings strictly", () => {
    expect(() => parseFrozenAgentBindingMap({
      reviewer: {
        source: { kind: "direct" },
        injection: { use: "codex", cwd: "" },
      },
    })).toThrow();
    expect(() => parseFrozenAgentBindingMap({
      reviewer: {
        source: { kind: "workflow" },
        effective: { kind: "agent_definition", use: "codex" },
      },
    })).toThrow();
    expect(() => parseFrozenAgentBindingMap({
      reviewer: {
        source: { kind: "direct" },
        materializedInjection: { use: "codex" },
      },
    })).toThrow();
    expect(() => parseFrozenAgentBindingMap({
      reviewer: {
        source: {
          kind: "preset",
          id: "reviewer",
          scope: "project",
          definitionDigest: `sha256:${"0".repeat(64)}`,
        },
        injection: { use: "codex" },
      },
    })).toThrow();
  });

  it("requires every slot and reports missing names in stable order", async () => {
    const result = await finalizeAgentBindings({
      declarations: {
        zebra: { kind: "agent_slot" },
        alpha: { kind: "agent_slot" },
        fixed: { kind: "agent_definition", use: "codex" },
      },
    });

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "agent-bindings-unresolved",
      agentNames: ["alpha", "zebra"],
      message: "Agent bindings are required for: alpha, zebra.",
    });
  });

  it("treats prototype-looking Agent names as ordinary map keys", async () => {
    const declarations = Object.fromEntries([
      ["__proto__", { kind: "agent_slot" }],
    ]) as Record<string, AgentDeclarationIR>;
    const injections = Object.fromEntries([
      ["__proto__", { use: "codex" }],
    ]);
    const result = await finalizeAgentBindings({ declarations, injections });

    expect(Object.hasOwn(result._unsafeUnwrap().bindings, "__proto__")).toBe(true);
    expect(result._unsafeUnwrap().agents.__proto__).toMatchObject({ kind: "agent_definition", use: "codex" });
    const roundTripped = parseFrozenAgentBindingMap(JSON.parse(JSON.stringify(result._unsafeUnwrap().bindings)));
    expect(Object.hasOwn(roundTripped, "__proto__")).toBe(true);
    expect(roundTripped.__proto__?.injection).toEqual({ use: "codex" });

    const missing = await finalizeAgentBindings({ declarations });
    expect(missing._unsafeUnwrapErr()).toMatchObject({
      type: "agent-bindings-unresolved",
      agentNames: ["__proto__"],
    });
    const replacement = await finalizeAgentBindings({ declarations, inherited: {} });
    expect(replacement._unsafeUnwrapErr()).toMatchObject({
      type: "agent-bindings-unresolved",
      agentNames: ["__proto__"],
    });
  });

  it("preserves prototype-looking config keys through parsing and binding", async () => {
    const injections = JSON.parse('{"reviewer":{"use":"codex","config":{"__proto__":"kept"}}}');
    const result = await finalizeAgentBindings({
      declarations: { reviewer: { kind: "agent_slot" } },
      injections,
    });
    const config = result._unsafeUnwrap().agents.reviewer?.config;

    expect(config && Object.hasOwn(config, "__proto__")).toBe(true);
    expect(config?.__proto__).toBe("kept");
  });

  it("expands presets at finalization while preserving slot defaults", async () => {
    const catalog = await loadAgentPresetCatalog({
      scopes: ["host"],
      hostProvider: () => new ResultAsync(Promise.resolve(ok([
        { id: "reviewer", guidance: "Review changes", agent: { use: "codex", config: { effort: "high" } } },
      ]))),
    });
    const result = await finalizeAgentBindings({
      declarations: {
        reviewer: { kind: "agent_slot", model: "gpt-5.4", permissionMode: "deny-all" },
      },
      injections: { reviewer: { preset: "reviewer" } },
      presetCatalog: catalog._unsafeUnwrap(),
    });

    expect(result._unsafeUnwrap()).toEqual({
      agents: {
        reviewer: {
          kind: "agent_definition",
          use: "codex",
          model: "gpt-5.4",
          permissionMode: "deny-all",
          config: { effort: "high" },
        },
      },
      bindings: {
        reviewer: {
          source: { kind: "preset", id: "reviewer", scope: "host" },
          injection: { use: "codex", config: { effort: "high" } },
        },
      },
    });
  });

  it("reapplies only the frozen injection when a fork replaces the workflow", async () => {
    const original = await finalizeAgentBindings({
      declarations: {
        reviewer: declaration({
          use: "declared-old",
          model: "old-model",
          config: { authored: "old" },
          cwd: "/old",
          env: { WORKFLOW: "old" },
        }),
      },
      injections: { reviewer: { use: "injected" } },
    });
    const replacement = await finalizeAgentBindings({
      declarations: {
        reviewer: declaration({
          use: "declared-new",
          model: "new-model",
          config: { authored: "new" },
          cwd: "/new",
          env: { WORKFLOW: "new" },
        }),
      },
      inherited: original._unsafeUnwrap().bindings,
    });

    expect(replacement._unsafeUnwrap().agents.reviewer).toEqual({
      kind: "agent_definition",
      use: "injected",
      cwd: "/new",
      env: { WORKFLOW: "new" },
    });
  });

  it("keeps identity provenance when a direct injection changes only fields", async () => {
    const result = await finalizeAgentBindings({
      declarations: { reviewer: declaration({ use: "codex", model: "old" }) },
      injections: { reviewer: { model: "new" } },
    });

    expect(result._unsafeUnwrap().bindings.reviewer).toMatchObject({
      source: { kind: "workflow" },
      injection: { model: "new" },
    });
    expect(result._unsafeUnwrap().agents.reviewer).toEqual({ kind: "agent_definition", use: "codex", model: "new" });
  });

  it("keeps Preset identity provenance after a field-only override", async () => {
    const declarations = { reviewer: { kind: "agent_slot" as const } };
    const catalog = await loadAgentPresetCatalog({
      scopes: ["host"],
      hostProvider: () => new ResultAsync(Promise.resolve(ok([
        {
          id: "reviewer",
          guidance: "Review",
          agent: { use: "codex", model: "old", config: { effort: "high" }, env: { SOURCE: "yes" } },
        },
      ]))),
    });
    const source = await finalizeAgentBindings({
      declarations,
      injections: { reviewer: { preset: "reviewer" } },
      presetCatalog: catalog._unsafeUnwrap(),
    });
    const sourceBinding = source._unsafeUnwrap().bindings.reviewer!;
    const child = await finalizeAgentBindings({
      declarations,
      inherited: source._unsafeUnwrap().bindings,
      injections: {
        reviewer: { model: "new", config: { effort: "low" }, env: { CHILD: "yes" } },
      },
    });
    const childBinding = child._unsafeUnwrap().bindings.reviewer!;

    expect(childBinding).toMatchObject({
      source: { kind: "preset", id: "reviewer", scope: "host" },
      injection: {
        use: "codex",
        model: "new",
        config: { effort: "low" },
        env: { CHILD: "yes" },
      },
    });
    expect(child._unsafeUnwrap().agents.reviewer).toEqual({
      kind: "agent_definition",
      use: "codex",
      model: "new",
      config: { effort: "low" },
      env: { CHILD: "yes" },
    });
    expect(childBinding.source).toEqual(sourceBinding.source);
    expect(rebuildFrozenAgentBindings(declarations, child._unsafeUnwrap().bindings)).toEqual(child._unsafeUnwrap());
  });

  it("rejects impossible and non-canonical frozen bindings", () => {
    expect(() => rebuildFrozenAgentBindings(
      { reviewer: { kind: "agent_slot" } },
      { reviewer: { source: { kind: "direct" }, injection: { model: "gpt" } } },
    )).toThrow(/direct source requires a frozen identity/);
    expect(() => rebuildFrozenAgentBindings(
      { reviewer: declaration({ use: "codex" }) },
      { reviewer: { source: { kind: "workflow" }, injection: { use: "claude" } } },
    )).toThrow(/workflow source must not contain a frozen identity/);
    expect(() => rebuildFrozenAgentBindings(
      { reviewer: { kind: "agent_slot" } },
      { reviewer: { source: { kind: "preset", id: "dsh", scope: "project" }, injection: { use: "codex" } } },
    )).toThrow(/reserved Preset id 'dsh'/);
    expect(() => rebuildFrozenAgentBindings(
      { reviewer: declaration({ use: "codex" }) },
      { reviewer: { source: { kind: "workflow" }, injection: {} } },
    )).toThrow(/not canonical/);
    expect(() => rebuildFrozenAgentBindings(
      { reviewer: { kind: "agent_slot" } },
      { reviewer: { source: { kind: "workflow" } } },
    )).toThrow(/bindings are incomplete/);
  });
});

function declaration(input: {
  use: string;
  model?: string;
  config?: Record<string, string>;
  cwd?: string;
  env?: Record<string, string>;
}): AgentDeclarationIR {
  return { kind: "agent_definition", ...input };
}
