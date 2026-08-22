import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  dshAgentPresetProvider,
  renderAgentPresetCatalog,
  toAgentPresetView,
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

  it("renders only safe selection choices for prompt assembly", () => {
    const choices = [{
      id: "dsh",
      guidance: "Built-in DSH.",
      scope: "host" as const,
    }, {
      id: "reviewer",
      guidance: "Independent review.",
      scope: "global" as const,
    }];

    const rendered = renderAgentPresetCatalog(choices);
    const catalog = JSON.parse(rendered.split("\n").find(line => line.startsWith("["))!);

    expect(catalog).toEqual(choices);
    expect(rendered).not.toContain("command");
    expect(rendered).not.toContain("model");
    expect(rendered).not.toContain("env");
    expect(toAgentPresetView(choices[1]!)).toEqual(choices[1]);
  });
});
