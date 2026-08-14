import { describe, expect, it } from "vitest";
import { appViewFromUrl, urlForAppView } from "../src/client/ui/navigation.js";

describe("WebUI URL navigation", () => {
  it("parses run, workspace, and workflow views with run precedence", () => {
    expect(appViewFromUrl(new URL("http://localhost/?run=run_alpha"))).toEqual({
      page: "run-monitor",
      runId: "run_alpha",
    });
    expect(appViewFromUrl(new URL("http://localhost/?workspace=ws_remote&run=run_remote"))).toEqual({
      page: "run-monitor",
      workspaceKey: "ws_remote",
      runId: "run_remote",
    });
    expect(appViewFromUrl(new URL("http://localhost/?view=workflows&run=run_alpha"))).toEqual({
      page: "run-monitor",
      runId: "run_alpha",
    });
    expect(appViewFromUrl(new URL("http://localhost/?view=workflows"))).toEqual({ page: "workflows" });
    expect(appViewFromUrl(new URL("http://localhost/?workspace=ws_remote"))).toEqual({
      page: "runs",
      workspaceKey: "ws_remote",
    });
    expect(appViewFromUrl(new URL("http://localhost/?run=%20&workspace=%20"))).toEqual({ page: "runs" });
  });

  it("writes only owned parameters and preserves access and caller state", () => {
    const current = new URL("http://localhost/?token=secret&caller=watch#graph");

    expect(urlForAppView(current, {
      page: "run-monitor",
      workspaceKey: "ws_current",
      runId: "run alpha",
    }, "ws_current").href).toBe("http://localhost/?token=secret&caller=watch&run=run+alpha#graph");

    expect(urlForAppView(current, {
      page: "run-monitor",
      workspaceKey: "ws_remote",
      runId: "run_remote",
    }, "ws_current").href).toBe("http://localhost/?token=secret&caller=watch&workspace=ws_remote&run=run_remote#graph");

    expect(urlForAppView(new URL("http://localhost/?token=secret&workspace=old&run=old"), {
      page: "workflows",
    }, "ws_current").href).toBe("http://localhost/?token=secret&view=workflows");
  });
});
