// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minimalReportView } from "../helpers/report-fixtures.js";

vi.mock("elkjs/lib/elk.bundled.js", () => ({
  default: class {
    async layout(graph: { children?: Array<{ id: string }> }) {
      return {
        ...graph,
        children: (graph.children ?? []).map((child, index) => ({ ...child, x: index * 220, y: 0 }))
      };
    }
  }
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => React.createElement("div", { "data-testid": "flow-provider" }, children),
    ReactFlow: ({ nodes }: { nodes: Array<{ id: string; data?: { label?: string } }> }) => React.createElement(
      "div",
      { "data-testid": "react-flow" },
      nodes.map((node) => React.createElement("button", { key: node.id, "data-stage-node": node.data?.label ?? node.id }, node.data?.label ?? node.id))
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Left: "left", Right: "right" }
  };
});

describe("ReportApp", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  it("renders snapshot navigation, metrics, graph, and detail preview state", async () => {
    const view = minimalReportView("ui-run");
    view.stages[0].output = {
      text: "{\"status\":\"completed\",\"summary\":\"Fixture summary\"}",
      truncated: true,
      originalChars: 512,
      path: "/tmp/output.json"
    };
    document.body.innerHTML = `<script id="acpx-report-snapshot" type="application/json">${JSON.stringify(view)}</script>`;
    const { ReportApp } = await import("../../web-report/src/ReportApp.js");

    render(<ReportApp />);

    expect(screen.getByRole("heading", { name: "fixture" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stages" })).toBeInTheDocument();
    expect(screen.getAllByText("1/1").length).toBeGreaterThan(0);
    expect(screen.getByTestId("report-graph")).toBeInTheDocument();
    expect(screen.getByText(/truncated from 512 chars/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stages" }));
    expect(screen.getByRole("columnheader", { name: "Stage" })).toBeInTheDocument();
    expect(screen.getAllByRole("cell", { name: "summarize" }).length).toBeGreaterThan(0);
  });
});
