import * as React from "react";
import type { RenderOptions } from "@vercel/beautiful-mermaid";
import MarkdownIt, { type RendererRule } from "markdown-it";

type MarkdownDocumentProps = {
  value: string;
  variant: "compact" | "reading";
};

type MermaidModule = typeof import("@vercel/beautiful-mermaid");

const mermaidOptions = {
  bg: "var(--ui-surface-raised)",
  fg: "var(--ui-text)",
  line: "var(--graph-edge)",
  accent: "var(--ui-primary-text)",
  muted: "var(--ui-text-muted)",
  surface: "var(--ui-surface-raised)",
  border: "var(--graph-structure-border)",
  font: "Outfit",
  groupFont: "IBM Plex Mono",
  transparent: true,
  padding: 24,
  nodePaddingX: 24,
  nodePaddingY: 12,
  cornerRadius: 3,
  groupCornerRadius: 0,
  lineWidth: 1.2,
  edgeBendRadius: 3,
  animate: false,
} satisfies RenderOptions;

let mermaidModule: Promise<MermaidModule> | undefined;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const defaultImageRenderer = markdown.renderer.rules.image;
const renderLinkOpen: RendererRule = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index];
  const href = token?.attrGet("href");
  if (token && typeof href === "string" && isExternalHttpUrl(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return renderer.renderToken(tokens, index, options);
};

const renderImage: RendererRule = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  token?.attrSet("loading", "lazy");
  token?.attrSet("decoding", "async");
  return defaultImageRenderer?.(tokens, index, options, environment, renderer)
    ?? renderer.renderToken(tokens, index, options);
};

const renderFence = markdown.renderer.rules.fence;
const renderCodeBlock = markdown.renderer.rules.code_block;

markdown.renderer.rules.link_open = renderLinkOpen;
markdown.renderer.rules.image = renderImage;
markdown.renderer.rules.table_open = () => '<div class="markdown-table-wrap" role="region" aria-label="Scrollable table" tabindex="0">\n<table>\n';
markdown.renderer.rules.table_close = () => "</table>\n</div>\n";
markdown.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  const language = token?.info.trim().split(/\s+/, 1)[0];
  if (token && language?.toLowerCase() === "mermaid") {
    return renderMermaidPlaceholder(token.content);
  }

  const rendered = makeCodeBlockKeyboardScrollable(
    renderFence?.(tokens, index, options, environment, renderer)
      ?? renderer.renderToken(tokens, index, options),
  );
  if (!language) return `<figure class="markdown-code-block">${rendered}</figure>`;
  return `<figure class="markdown-code-block"><figcaption>${markdown.utils.escapeHtml(language)}</figcaption>${rendered}</figure>`;
};
markdown.renderer.rules.code_block = (tokens, index, options, environment, renderer) => makeCodeBlockKeyboardScrollable(
  renderCodeBlock?.(tokens, index, options, environment, renderer)
    ?? renderer.renderToken(tokens, index, options),
);

markdown.core.ruler.after("inline", "task-list-items", state => {
  for (let index = 2; index < state.tokens.length; index += 1) {
    const inline = state.tokens[index];
    const paragraph = state.tokens[index - 1];
    const listItem = state.tokens[index - 2];
    const marker = inline?.content.match(/^\[([ xX])]\s+/);
    const firstChild = inline?.children?.[0];
    const childMarker = firstChild?.type === "text" ? firstChild.content.match(/^\[([ xX])]\s+/) : null;
    if (
      inline?.type !== "inline"
      || paragraph?.type !== "paragraph_open"
      || listItem?.type !== "list_item_open"
      || !marker
      || firstChild?.type !== "text"
      || !childMarker
    ) {
      continue;
    }

    inline.content = inline.content.slice(marker[0].length);
    firstChild.content = firstChild.content.slice(childMarker[0].length);
    const checkbox = new state.Token("html_inline", "", 0);
    const checked = marker[1]?.toLowerCase() === "x";
    checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? " checked" : ""}>`;
    inline.children?.unshift(checkbox);
    listItem.attrJoin("class", "task-list-item");

    const parentLevel = listItem.level - 1;
    for (let parentIndex = index - 3; parentIndex >= 0; parentIndex -= 1) {
      const candidate = state.tokens[parentIndex];
      if (candidate?.level === parentLevel) {
        if (candidate.type === "bullet_list_open" || candidate.type === "ordered_list_open") {
          candidate.attrJoin("class", "contains-task-list");
        }
        break;
      }
    }
  }
});

export function MarkdownDocument({ value, variant }: MarkdownDocumentProps) {
  const documentRef = React.useRef<HTMLElement>(null);
  const html = React.useMemo(() => markdown.render(value), [value]);

  React.useEffect(() => {
    const figures = [...(documentRef.current?.querySelectorAll<HTMLElement>(".markdown-mermaid[data-mermaid-state='pending']") ?? [])];
    if (figures.length === 0) return;

    let active = true;
    void loadMermaid().then(module => {
      if (!active) return;
      for (const figure of figures) {
        void renderMermaidFigure(figure, module, () => active).catch(error => {
          if (active && figure.isConnected) markMermaidFailure(figure, error);
        });
      }
    }).catch(error => {
      if (!active) return;
      for (const figure of figures) {
        if (figure.isConnected) markMermaidFailure(figure, error);
      }
    });

    return () => {
      active = false;
    };
  }, [html]);

  return (
    <article
      ref={documentRef}
      className={`markdown-document ${variant}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function isExternalHttpUrl(href: string): boolean {
  try {
    const current = new URL(globalThis.location?.href ?? "http://acpus.local/");
    const url = new URL(href, current);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== current.origin;
  } catch {
    return false;
  }
}

function makeCodeBlockKeyboardScrollable(rendered: string): string {
  return rendered.replace("<pre>", '<pre tabindex="0">');
}

function renderMermaidPlaceholder(source: string): string {
  return [
    '<figure class="markdown-mermaid" data-mermaid-state="pending">',
    '<figcaption><span>Mermaid</span><span class="markdown-mermaid-status" aria-live="polite">Rendering diagram…</span></figcaption>',
    '<div class="markdown-mermaid-canvas" role="region" aria-label="Mermaid diagram" aria-busy="true" tabindex="0">',
    `<pre tabindex="0"><code class="language-mermaid">${markdown.utils.escapeHtml(source)}</code></pre>`,
    "</div>",
    "</figure>",
  ].join("");
}

function loadMermaid(): Promise<MermaidModule> {
  mermaidModule ??= import("@vercel/beautiful-mermaid");
  return mermaidModule;
}

async function renderMermaidFigure(
  figure: HTMLElement,
  module: MermaidModule,
  isActive: () => boolean,
): Promise<void> {
  const canvas = figure.querySelector<HTMLElement>(".markdown-mermaid-canvas");
  const source = canvas?.querySelector("code")?.textContent;
  if (!canvas || source === undefined) return;

  const options = containsWideGlyphs(source)
    ? { ...mermaidOptions, nodePaddingX: 76 }
    : mermaidOptions;
  const svg = await module.renderMermaid(source, options);
  if (!isActive() || !figure.isConnected) return;
  canvas.innerHTML = prepareGeneratedMermaidSvg(svg);
  canvas.scrollLeft = Math.max(0, (canvas.scrollWidth - canvas.clientWidth) / 2);
  canvas.removeAttribute("aria-busy");
  figure.dataset.mermaidState = "rendered";
  setMermaidStatus(figure, "Diagram");
}

function markMermaidFailure(figure: HTMLElement, error: unknown): void {
  const canvas = figure.querySelector<HTMLElement>(".markdown-mermaid-canvas");
  canvas?.removeAttribute("aria-busy");
  figure.dataset.mermaidState = "error";
  const status = setMermaidStatus(figure, "Could not render · source shown");
  if (status && error instanceof Error) status.title = error.message;
}

function setMermaidStatus(figure: HTMLElement, label: string): HTMLElement | undefined {
  const status = figure.querySelector<HTMLElement>(".markdown-mermaid-status") ?? undefined;
  if (status) status.textContent = label;
  return status;
}

function prepareGeneratedMermaidSvg(svg: string): string {
  return svg
    .replace(/^[ \t]*@import url\('https:\/\/fonts\.googleapis\.com\/[^']+'\);[ \t]*\r?\n/gmu, "")
    .replace("<svg ", '<svg role="img" aria-label="Rendered Mermaid diagram" ');
}

function containsWideGlyphs(source: string): boolean {
  return /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(source);
}
