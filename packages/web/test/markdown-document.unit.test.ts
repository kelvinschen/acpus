// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../src/client/ui/MarkdownDocument.js";
import { installReactActEnvironment, waitForReact } from "./support/react-act-environment.js";

describe("MarkdownDocument", () => {
  it("renders complete document structure with GFM extensions", () => {
    const document = renderMarkdown(`
# Research report

## Findings

Paragraph with **strong**, *emphasis*, ~~obsolete~~, and \`inline code\`.

> Evidence should remain attributable.

- Primary item
  - Nested item

1. First step
2. Second step

- [x] Reviewed
- [ ] Publish

| Signal | Value |
| :--- | ---: |
| confidence | 0.94 |

\`\`\`ts
const answer = 42;
\`\`\`

https://example.com/evidence

![Workflow diagram](https://example.com/workflow.png)
`, "reading");

    expect(document.matches("article.markdown-document.reading")).toBe(true);
    expect(document.querySelector("h1")?.textContent).toBe("Research report");
    expect(document.querySelector("h2")?.textContent).toBe("Findings");
    expect(document.querySelector("strong")?.textContent).toBe("strong");
    expect(document.querySelector("em")?.textContent).toBe("emphasis");
    expect(document.querySelector("s")?.textContent).toBe("obsolete");
    expect(document.querySelector("blockquote")?.textContent).toContain("attributable");
    expect(document.querySelectorAll("ul").length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector("ol")).not.toBeNull();

    const tasks = [...document.querySelectorAll<HTMLInputElement>(".task-list-item-checkbox")];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.disabled).toBe(true);
    expect(tasks[0]?.checked).toBe(true);
    expect(tasks[1]?.checked).toBe(false);
    expect(document.querySelector(".contains-task-list")).not.toBeNull();

    const tableRegion = document.querySelector<HTMLElement>(".markdown-table-wrap");
    expect(tableRegion?.getAttribute("role")).toBe("region");
    expect(tableRegion?.tabIndex).toBe(0);
    expect(tableRegion?.querySelectorAll("thead th")).toHaveLength(2);
    expect(tableRegion?.querySelector("tbody td")?.textContent).toBe("confidence");

    expect(document.querySelector(".markdown-code-block figcaption")?.textContent).toBe("ts");
    const code = document.querySelector<HTMLElement>("pre > code.language-ts");
    expect(code?.textContent).toContain("const answer = 42;");
    expect(code?.parentElement?.tabIndex).toBe(0);
    const autolink = [...document.querySelectorAll<HTMLAnchorElement>("a")]
      .find(anchor => anchor.href === "https://example.com/evidence");
    expect(autolink?.target).toBe("_blank");
    expect(autolink?.rel).toBe("noopener noreferrer");
    const image = document.querySelector<HTMLImageElement>("img");
    expect(image?.alt).toBe("Workflow diagram");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
  });

  it("keeps authored HTML inert and rejects unsafe links", () => {
    const document = renderMarkdown(`
<script>window.compromised = true</script>

<section data-danger="true">Raw HTML</section>

[Unsafe](javascript:alert(1))

[Relative](/runs)

[External](https://example.com/report)
`, "compact");

    expect(document.matches("article.markdown-document.compact")).toBe(true);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("section[data-danger]")).toBeNull();
    expect(document.textContent).toContain("<script>window.compromised = true</script>");
    expect([...document.querySelectorAll<HTMLAnchorElement>("a")]
      .some(anchor => anchor.getAttribute("href")?.startsWith("javascript:"))).toBe(false);

    const relative = [...document.querySelectorAll<HTMLAnchorElement>("a")]
      .find(anchor => anchor.textContent === "Relative");
    expect(relative?.getAttribute("href")).toBe("/runs");
    expect(relative?.hasAttribute("target")).toBe(false);
    const external = [...document.querySelectorAll<HTMLAnchorElement>("a")]
      .find(anchor => anchor.textContent === "External");
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener noreferrer");
  });

  it("renders Mermaid fences as themed, keyboard-scrollable diagrams", async () => {
    const mounted = await mountMarkdown(`
\`\`\`mermaid
flowchart LR
  Queue --> Ready{Ready?}
  Ready -->|yes| Run
\`\`\`

\`\`\`ts
const ordinaryFence = true;
\`\`\`
`);

    try {
      await waitForReact(() => expect(
        mounted.container.querySelector(".markdown-mermaid[data-mermaid-state='rendered'] svg"),
      ).not.toBeNull());

      const canvas = mounted.container.querySelector<HTMLElement>(".markdown-mermaid-canvas");
      const svg = canvas?.querySelector<SVGElement>("svg");
      expect(canvas?.getAttribute("role")).toBe("region");
      expect(canvas?.getAttribute("aria-label")).toBe("Mermaid diagram");
      expect(canvas?.tabIndex).toBe(0);
      expect(svg?.getAttribute("role")).toBe("img");
      expect(svg?.getAttribute("aria-label")).toBe("Rendered Mermaid diagram");
      expect(svg?.getAttribute("style")).toContain("--accent:var(--ui-primary-text)");
      expect(svg?.textContent).not.toContain("@import url");
      expect(mounted.container.querySelector(".markdown-mermaid-status")?.textContent).toBe("Diagram");
      expect(mounted.container.querySelector(".markdown-code-block code.language-ts")?.textContent)
        .toContain("ordinaryFence");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps complete Mermaid source visible when the diagram is unsupported", async () => {
    const source = "this is not a supported Mermaid diagram";
    const mounted = await mountMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``);

    try {
      await waitForReact(() => expect(
        mounted.container.querySelector(".markdown-mermaid")?.getAttribute("data-mermaid-state"),
      ).toBe("error"));
      expect(mounted.container.querySelector(".markdown-mermaid-status")?.textContent)
        .toBe("Could not render · source shown");
      expect(mounted.container.querySelector("code.language-mermaid")?.textContent).toBe(`${source}\n`);
      expect(mounted.container.querySelector(".markdown-mermaid svg")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps diagram-authored markup as SVG text", async () => {
    const mounted = await mountMarkdown(`
\`\`\`mermaid
flowchart LR
  A["<script>globalThis.compromised = true</script><img src=x onerror=alert(1)>"] --> B
\`\`\`
`);

    try {
      await waitForReact(() => expect(
        mounted.container.querySelector(".markdown-mermaid[data-mermaid-state='rendered'] svg"),
      ).not.toBeNull());
      expect(mounted.container.querySelector(".markdown-mermaid script")).toBeNull();
      expect(mounted.container.querySelector(".markdown-mermaid foreignObject")).toBeNull();
      expect(mounted.container.querySelector(".markdown-mermaid [onerror]")).toBeNull();
      expect(mounted.container.querySelector(".markdown-mermaid text")?.textContent).toContain("<script>");
    } finally {
      await mounted.unmount();
    }
  });
});

function renderMarkdown(value: string, variant: "compact" | "reading"): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(React.createElement(MarkdownDocument, { value, variant }));
  const rendered = container.firstElementChild;
  if (!(rendered instanceof HTMLElement)) throw new TypeError("MarkdownDocument did not render an element.");
  return rendered;
}

async function mountMarkdown(value: string): Promise<{
  container: HTMLDivElement;
  unmount(): Promise<void>;
}> {
  const restoreReactActEnvironment = installReactActEnvironment();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MarkdownDocument, { value, variant: "reading" }));
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      restoreReactActEnvironment();
    },
  };
}
