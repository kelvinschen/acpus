import { describe, expect, it } from "vitest";
import { planPruneSelection } from "../src/runs/prune.js";

describe("run prune selection", () => {
  it("selects every terminal run and sealed generation when no age is requested", () => {
    const selected = planPruneSelection({
      runs: [
        run("completed"),
        run("failed"),
        run("canceled"),
        run("running"),
        run("paused"),
        run("awaiting"),
      ],
      generations: [
        { id: "gen_old", createdAt: "2026-07-23T12:00:00.000Z" },
        { id: "gen_new", createdAt: "2026-07-24T12:00:00.000Z" },
      ],
    });

    expect(selected).toEqual({
      runIds: ["completed", "failed", "canceled"],
      generationIds: ["gen_old", "gen_new"],
    });
  });

  it("uses one strict cutoff for run updates and generation sealing", () => {
    const selected = planPruneSelection({
      cutoff: "2026-07-24T12:00:00.000Z",
      runs: [
        run("completed", "2026-07-24T11:59:59.999Z", "before"),
        run("failed", "2026-07-24T12:00:00.000Z", "equal"),
        run("canceled", "2026-07-24T12:00:00.001Z", "after"),
        run("running", "2026-07-01T00:00:00.000Z", "active"),
      ],
      generations: [
        {
          id: "sealed-before",
          createdAt: "2026-08-01T00:00:00.000Z",
          sealedAt: "2026-07-24T11:59:59.999Z",
        },
        {
          id: "sealed-equal",
          createdAt: "2026-07-01T00:00:00.000Z",
          sealedAt: "2026-07-24T12:00:00.000Z",
        },
        { id: "created-before", createdAt: "2026-07-24T11:59:59.999Z" },
        { id: "created-after", createdAt: "2026-07-24T12:00:00.001Z" },
      ],
    });

    expect(selected).toEqual({
      runIds: ["before"],
      generationIds: ["sealed-before", "created-before"],
    });
  });
});

function run(
  status: string,
  updatedAt = "2026-07-24T00:00:00.000Z",
  id = status,
): { id: string; status: string; updatedAt: string } {
  return { id, status, updatedAt };
}
