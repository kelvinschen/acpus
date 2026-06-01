import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { escapeJsonForHtml, injectReportPayload, inlineReportAssets } from "../../src/reports/html.js";
import { minimalReportView, writeReportWebBundle } from "../helpers/report-fixtures.js";

describe("HTML report rendering helpers", () => {
  it("inlines built assets and removes external references", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-report-web-"));
    await writeReportWebBundle(root);
    const webRoot = path.join(root, "dist", "report-web");
    const html = await fs.readFile(path.join(webRoot, "index.html"), "utf8");
    const inlined = await inlineReportAssets(html, webRoot);

    expect(inlined).toContain("<style data-inlined-from=\"./assets/index.css\">");
    expect(inlined).toContain("<script type=\"module\" data-inlined-from=\"./assets/index.js\">");
    expect(inlined).not.toContain("href=\"./assets/index.css\"");
    expect(inlined).not.toContain("src=\"./assets/index.js\"");
  });

  it("embeds snapshot payload as escaped JSON", () => {
    const view = minimalReportView("unsafe-run");
    view.summary.summary = "</script><img src=x onerror=alert(1)>";
    const html = injectReportPayload("<html><body><div id=\"root\"></div></body></html>", { snapshot: view });

    expect(html).toContain("id=\"acpx-report-snapshot\"");
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain("</script><img");
  });

  it("escapes JSON characters that can break HTML script contexts", () => {
    const escaped = escapeJsonForHtml({ text: "<tag>&line\u2028next\u2029" });

    expect(escaped).toContain("\\u003ctag\\u003e");
    expect(escaped).toContain("\\u0026");
    expect(escaped).toContain("\\u2028");
    expect(escaped).toContain("\\u2029");
  });
});
