import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDshAgentLaunches } from "../src/host/dsh-agent.js";

describe("built-in DSH Agent launch", () => {
  it("pins the package launcher and DSH home in structured argv", () => {
    const dshHome = resolve("private-dsh-home");
    const launches = createDshAgentLaunches(dshHome);

    const launch = launches.dsh?.({ model: "selected-model" });

    expect(launch).toEqual(expect.arrayContaining([
      process.execPath,
      "--dsh-home",
      dshHome,
      "--model",
      "selected-model",
    ]));
    expect(Array.isArray(launch) && launch.some(value => value.endsWith("dsh-acp-agent-bin.ts")))
      .toBe(true);
  });

  it("omits the model argument when the workflow did not select one", () => {
    const launch = createDshAgentLaunches(resolve("private-dsh-home")).dsh?.({});

    expect(launch).not.toContain("--model");
  });
});
