import { describe, expect, it } from "vitest";
import { planPruneSelection } from "../src/runs/prune.js";

describe("run prune selection", () => {
  it("selects every terminal run and archive when no age is requested", () => {
    const selected = planPruneSelection({
      runs: [
        run("completed"),
        run("failed"),
        run("canceled"),
        run("running"),
        run("paused"),
        run("awaiting"),
      ],
      archives: [
        { name: "20260723T120000.000Z-v1" },
        { name: "20260724T120000.000Z-v1" },
      ],
    });

    expect(selected).toEqual({
      runIds: ["completed", "failed", "canceled"],
      archiveNames: ["20260723T120000.000Z-v1", "20260724T120000.000Z-v1"],
    });
  });

  it("uses one strict cutoff for run updates and archive creation", () => {
    const selected = planPruneSelection({
      cutoff: "2026-07-24T12:00:00.000Z",
      runs: [
        run("completed", "2026-07-24T11:59:59.999Z", "before"),
        run("failed", "2026-07-24T12:00:00.000Z", "equal"),
        run("canceled", "2026-07-24T12:00:00.001Z", "after"),
        run("running", "2026-07-01T00:00:00.000Z", "active"),
      ],
      archives: [
        { name: "20260724T115959.999Z-v1" },
        { name: "20260724T120000.000Z-v1" },
        { name: "20260724T120000.001Z-v1" },
      ],
    });

    expect(selected).toEqual({
      runIds: ["before"],
      archiveNames: ["20260724T115959.999Z-v1"],
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
