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

  it("rejects empty cwd values in persisted bindings", () => {
    expect(() => parseFrozenAgentBindingMap({
      reviewer: {
        source: { kind: "direct" },
        effective: { kind: "agent_definition", use: "codex" },
        materializedInjection: { cwd: "" },
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
    expect(roundTripped.__proto__?.effective).toMatchObject({ kind: "agent_definition", use: "codex" });

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
        reviewer: expect.objectContaining({
          source: expect.objectContaining({ kind: "preset", id: "reviewer", scope: "host" }),
          materializedInjection: { use: "codex", config: { effort: "high" } },
        }),
      },
    });
  });

  it("reapplies only the materialized injection when a fork replaces the workflow", async () => {
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
      effective: { kind: "agent_definition", use: "codex", model: "new" },
      materializedInjection: { model: "new" },
    });
  });

  it("keeps Preset identity provenance and refreshes its digest after a field-only override", async () => {
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
      effective: {
        kind: "agent_definition",
        use: "codex",
        model: "new",
        config: { effort: "low" },
        env: { CHILD: "yes" },
      },
      materializedInjection: {
        use: "codex",
        model: "new",
        config: { effort: "low" },
        env: { CHILD: "yes" },
      },
    });
    expect(childBinding.source).not.toEqual(sourceBinding.source);
    expect(rebuildFrozenAgentBindings(declarations, child._unsafeUnwrap().bindings)).toEqual(child._unsafeUnwrap());
  });

  it("rejects a frozen effective definition that diverges from its materialized injection", async () => {
    const declarations = { reviewer: { kind: "agent_slot" as const } };
    const finalized = await finalizeAgentBindings({
      declarations,
      injections: { reviewer: { use: "codex" } },
    });
    const tampered = structuredClone(finalized._unsafeUnwrap().bindings);
    tampered.reviewer!.effective = { kind: "agent_definition", use: "different" };

    expect(() => rebuildFrozenAgentBindings(declarations, tampered)).toThrow(/effective definitions do not match/);
  });

  it("rejects frozen Preset provenance that diverges from the materialized definition", async () => {
    const declarations = { reviewer: { kind: "agent_slot" as const } };
    const catalog = await loadAgentPresetCatalog({
      scopes: ["host"],
      hostProvider: () => new ResultAsync(Promise.resolve(ok([
        { id: "reviewer", guidance: "Review", agent: { use: "codex" } },
      ]))),
    });
    const finalized = await finalizeAgentBindings({
      declarations,
      injections: { reviewer: { preset: "reviewer" } },
      presetCatalog: catalog._unsafeUnwrap(),
    });
    const tampered = structuredClone(finalized._unsafeUnwrap().bindings);
    if (tampered.reviewer?.source.kind !== "preset") throw new Error("expected Preset binding");
    tampered.reviewer.source.definitionDigest = `sha256:${"0".repeat(64)}`;

    expect(() => rebuildFrozenAgentBindings(declarations, tampered)).toThrow(/definition digest does not match/);
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
