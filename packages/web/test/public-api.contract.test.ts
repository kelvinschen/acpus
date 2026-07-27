import { describe, expect, it } from "vitest";
import * as web from "@acpus/web";

describe("@acpus/web package boundary", () => {
  it("exposes only the supported runtime values", () => {
    expect(Object.keys(web).sort()).toEqual([
      "renderWorkflowVizHtml",
      "startWebServer",
      "workflowIrToWebGraph",
    ]);
  });
});
