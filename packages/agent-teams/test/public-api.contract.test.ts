import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as publicApi from "../src/index.js";

describe("Agent Teams public API", () => {
  it("exposes only the deep runtime and inspection seam", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "AgentTeamCommandFailure",
      "AgentTeamRunFailure",
      "inspectAgentTeam",
      "runAgentTeam",
    ]);
  });

  it("reports invalid runtime input through the typed error channel", async () => {
    const error = await Effect.runPromise(Effect.flip(publicApi.runAgentTeam({
      goal: "   ",
      cwd: process.cwd(),
      cliPath: process.execPath,
      agent: { kind: "named", name: "unused" },
    })));

    expect(error).toMatchObject({
      type: "agent_team_run_failure",
      phase: "setup",
      message: "The team goal must not be empty.",
    });
  });
});
