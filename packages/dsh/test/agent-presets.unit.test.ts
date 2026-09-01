import { describe, expect, it } from "vitest";
import type { AgentPresetCatalog } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  dshAgentPresetProvider,
  toAgentPresetSelectionView,
  toAgentPresetViews,
} from "../src/host/agent-presets.js";

describe("DSH Agent Preset adapter", () => {
  it("provides the immutable dsh definition through the Runtime Host seam", async () => {
    const provided = await Effect.runPromise(Effect.result(dshAgentPresetProvider({})));

    expect(Result.isSuccess(provided)).toBe(true);
    if (Result.isFailure(provided)) throw new Error(provided.failure.message);
    expect(provided.success).toEqual([{
      id: "dsh",
      guidance: expect.any(String),
      agent: { use: "dsh" },
    }]);
  });

  it("projects only safe selection choices for tool results", () => {
    const choices = [{
      id: "dsh",
      guidance: "Built-in DSH.",
      scope: "host" as const,
    }, {
      id: "reviewer",
      guidance: "Independent review.",
      scope: "global" as const,
    }];

    expect(toAgentPresetSelectionView(choices[1]!)).toEqual({
      id: "reviewer",
      guidance: "Independent review.",
      scope: "global",
    });
  });

  it("resolves concrete Agent details only for the human catalog", () => {
    const catalog = {
      choices: [{
        id: "reviewer",
        guidance: "Independent review.",
        scope: "global" as const,
      }],
      resolve: () => Result.succeed({
        reviewer: {
          id: "reviewer",
          scope: "global" as const,
          definition: {
            kind: "agent_definition" as const,
            use: "codex",
            model: "gpt-test",
            config: Object.fromEntries([
              ["reasoning_effort", "high"],
              ["__proto__", "kept"],
            ]),
            permissionMode: "approve-all" as const,
            cwd: "/private/workspace",
            env: { SECRET: "hidden" },
          },
        },
      }),
    } satisfies AgentPresetCatalog;

    expect(toAgentPresetViews(catalog)).toEqual([{
      id: "reviewer",
      guidance: "Independent review.",
      scope: "global",
      agent: {
        use: "codex",
        model: "gpt-test",
        config: [
          { key: "reasoning_effort", value: "high" },
          { key: "__proto__", value: "kept" },
        ],
      },
    }]);
  });
});
