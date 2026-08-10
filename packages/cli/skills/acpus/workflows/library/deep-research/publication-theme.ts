export const PUBLICATION_STYLE = String.raw`
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · genre: editorial · macrostructure: Long Document · theme: Newsprint · nav: document contents rail · enrichment: deterministic rich evidence */
/* Hallmark · vibe: "near-white cool paper, graphite ink, restrained carmine" · paper: oklch(99.2% .002 250) · accent: oklch(44% .175 19) */
/* Hallmark · headlines: system serif · reading: system sans · code: JetBrains Mono · axes: light / editorial / cool · context: explicit */
/* Hallmark · contrast: pass (40–41) · honest: pass (46) · chrome: pass (47) · tokens: pass (48) · mobile: pass (34, 50–57) */
:root {
  color-scheme: light;

  --space-3xs: .125rem;
  --space-2xs: .25rem;
  --space-xs: .5rem;
  --space-sm: .75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;
  --space-4xl: 9rem;

  --text-sm: .875rem;
  --text-md: 1.25rem;
  --text-lg: 1.625rem;
  --text-display: clamp(2.7rem, 5vw + .2rem, 4.9rem);

  --reading: 48rem;
  --medium: clamp(58rem, 62vw, 66rem);
  --evidence: 78rem;
  --shell: 100rem;
  --toc: clamp(12rem, 14vw, 14rem);
  --toc-gap: clamp(3.5rem, 4vw, 5rem);
  --rule-hair: 1px;
  --rule-strong: 2px;
  --rule-focus: 3px;
  --radius-small: 0;
  --radius-medium: 0;
  --radius-loader: 50%;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --dur-fast: 120ms;
  --dur-long: 280ms;

  --font-display: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, "Times New Roman", serif;
  --font-body: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;

  --color-page: oklch(99.2% .002 250);
  --color-paper: oklch(99.65% .001 250);
  --color-ink: oklch(24% .012 255);
  --color-ink-strong: oklch(17% .014 255);
  --color-muted: oklch(48% .012 250);
  --color-line: oklch(85% .008 245);
  --color-line-strong: oklch(58% .012 245);
  --color-soft: oklch(96.5% .006 245);
  --color-accent: oklch(44% .175 19);
  --color-accent-soft: oklch(97% .012 20);
  --color-focus: oklch(48% .2 19);
  --color-warning: oklch(52% .115 78);
  --color-warning-soft: oklch(97% .016 82);
  --color-danger: oklch(44% .175 19);
  --color-danger-soft: oklch(97% .012 20);
  --color-tip: oklch(45% .085 190);
  --color-tip-soft: oklch(97% .012 195);
  --color-source: oklch(96.3% .006 245);
  --color-source-ink: oklch(23% .016 255);
  --color-inline-code: oklch(93.8% .009 245);
  --color-inline-code-ink: oklch(25% .028 250);
  --color-code: oklch(96.7% .006 245);
  --color-code-ink: oklch(24% .018 255);
  --color-code-muted: oklch(45% .014 245);
  --color-code-keyword: oklch(42% .15 19);
  --color-code-title: oklch(41% .085 255);
  --color-code-string: oklch(39% .08 190);
  --color-code-number: oklch(43% .1 75);
  --color-chart-1: oklch(44% .175 19);
  --color-chart-2: oklch(44% .09 255);
  --color-chart-3: oklch(49% .085 190);
  --color-chart-4: oklch(48% .08 285);
  --color-chart-5: oklch(54% .06 235);
  --color-chart-6: oklch(58% .085 82);
  --color-chart-7: oklch(52% .1 345);
}

:root[data-language="zh-CN"] {
  --reading: 50rem;
  --text-display: clamp(2.65rem, 5vw + .15rem, 4.55rem);
  --font-display: ui-serif, "Songti SC", STSong, SimSun, serif;
  --font-body: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

:root[data-language="ja"] {
  --reading: 50rem;
  --text-display: clamp(2.65rem, 5vw + .15rem, 4.55rem);
  --font-display: ui-serif, "Yu Mincho", "Hiragino Mincho ProN", serif;
  --font-body: system-ui, -apple-system, BlinkMacSystemFont, "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif;
}

:root[data-language="ko"] {
  --reading: 50rem;
  --text-display: clamp(2.65rem, 5vw + .15rem, 4.55rem);
  --font-display: ui-serif, AppleMyungjo, Batang, serif;
  --font-body: system-ui, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
}

* { box-sizing: border-box; }
html, body { overflow-x: clip; }
html {
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
  background: var(--color-page);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body {
  margin: 0;
  background: var(--color-page);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: 16.25px;
  line-height: 1.7;
  text-rendering: optimizeLegibility;
}

a {
  color: var(--color-accent);
  text-decoration-thickness: .08em;
  text-underline-offset: .18em;
}
a:active { color: var(--color-ink-strong); }
a[aria-disabled="true"] {
  cursor: not-allowed;
  color: var(--color-muted);
  text-decoration: none;
}

@media (hover: hover) and (pointer: fine) {
  a:hover { text-decoration-thickness: .14em; }
}

a:focus-visible,
summary:focus-visible,
pre:focus-visible,
.heading-permalink:focus-visible,
.citation-backlink:focus-visible,
.mermaid-dialog-close:focus-visible,
.mermaid-dialog-viewport:focus-visible,
.interactive-frame:focus-visible,
[id^="source-"]:focus-visible,
h2:focus-visible,
h3:focus-visible,
.figure-scroll:focus-visible,
.katex-block:focus-visible,
.table-wrap:focus-visible {
  outline: var(--rule-focus) solid var(--color-focus);
  outline-offset: var(--space-2xs);
}

.citation {
  display: inline-block;
  padding-inline: var(--space-3xs);
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: .78em;
  font-weight: 700;
  line-height: 1.5;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.citation-preview-host {
  position: relative;
  display: inline-block;
}
.citation-preview-host + .citation-preview-host { margin-inline-start: var(--space-3xs); }
.citation-preview {
  position: fixed;
  z-index: 20;
  visibility: hidden;
  width: min(28rem, calc(100vw - 2rem));
  max-height: min(22rem, calc(100dvh - 2rem));
  padding: var(--space-sm) var(--space-md);
  overflow: auto;
  overscroll-behavior: contain;
  border: var(--rule-hair) solid var(--color-line);
  border-radius: .75rem;
  background: var(--color-paper);
  box-shadow:
    0 .125rem .5rem oklch(17% .014 255 / .04),
    0 .75rem 2.5rem oklch(17% .014 255 / .07);
  color: var(--color-source-ink);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  line-height: 1.55;
  overflow-wrap: anywhere;
  opacity: 0;
  pointer-events: none;
}
.citation-preview-host:not(.is-preview-dismissed):focus-within > .citation-preview {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}
.citation-preview-host:not(.is-preview-dismissed):focus-within > .citation {
  background-color: var(--color-accent-soft);
}
.citation-preview a { font-weight: 650; }
@media (hover: hover) and (pointer: fine) {
  .citation-preview-host:not(.is-preview-dismissed):hover > .citation-preview {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
  }
  .citation-preview-host:not(.is-preview-dismissed):hover > .citation {
    background-color: var(--color-accent-soft);
  }
  .publication:has(.citation-preview-host:hover) .citation-preview-host:not(:hover):focus-within > .citation-preview {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
  }
  .publication:has(.citation-preview-host:hover) .citation-preview-host:not(:hover):focus-within > .citation {
    background-color: transparent;
  }
}
.citation-backlink {
  position: relative;
  display: inline-grid;
  width: 2rem;
  height: 2rem;
  margin-inline-start: var(--space-2xs);
  place-items: center;
  vertical-align: middle;
  color: var(--color-muted);
  text-decoration: none;
}
.citation-backlink::before {
  content: "";
  position: absolute;
  inset: -.25rem;
}
.citation-backlink svg { width: 1rem; height: 1rem; }
.citation-backlink:hover { color: var(--color-accent); }
[id^="source-"] {
  scroll-margin-top: var(--space-xl);
  transition: background-color var(--dur-fast) var(--ease-out);
}
:is([id^="source-"], h2, h3, .citation).is-targeted { background-color: var(--color-accent-soft); }

.page-shell {
  width: min(100%, var(--shell));
  margin-inline: auto;
  padding: var(--space-lg) var(--space-md) var(--space-3xl);
}

.publication {
  --reading-inset: max(0px, calc((100% - var(--reading)) / 2));
  min-width: 0;
  font-family: var(--font-body);
  font-size: 1.0625rem;
  line-height: 1.74;
}
body.is-loading .publication { opacity: 0; }
body.is-ready .publication { animation: publication-enter var(--dur-long) var(--ease-out) both; }
@keyframes publication-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}

.publication > *,
.article-opening > *,
.article-body > * {
  width: min(100%, var(--reading));
  margin-inline: auto;
}

.publication > .article-opening {
  width: 100%;
  margin-inline: 0;
}

.publication > h1,
.article-opening > h1 {
  width: min(var(--medium), calc(100% - var(--reading-inset)));
  margin-inline-start: var(--reading-inset);
  margin-inline-end: 0;
}

.publication > .width-medium,
.publication > .width-evidence,
.article-opening > .width-medium,
.article-opening > .width-evidence,
.article-body > .width-medium,
.article-body > .width-evidence {
  margin-inline-start: var(--reading-inset);
  margin-inline-end: 0;
}
.publication > .width-medium,
.article-opening > .width-medium,
.article-body > .width-medium {
  width: min(var(--medium), calc(100% - var(--reading-inset)));
}
.publication > .width-evidence,
.article-opening > .width-evidence,
.article-body > .width-evidence {
  width: min(var(--evidence), calc(100% - var(--reading-inset)));
}

.publication > .article-layout {
  width: 100%;
  margin-block-start: var(--space-3xl);
  margin-inline: 0;
}
.article-opening--lead + .article-layout { margin-block-start: var(--space-2xl); }
.article-opening--lead + h2 { margin-block-start: var(--space-2xl); }
.article-body { min-width: 0; }
.article-body > h2:first-child { margin-block-start: 0; }

body.is-loading .publication-source { display: none; }
.publication-loader {
  display: grid;
  min-height: min(58vh, 520px);
  place-items: center;
}
.publication-loader[hidden] { display: none; }
.loading-indicator {
  width: 28px;
  height: 28px;
  border: var(--rule-strong) solid var(--color-line);
  border-top-color: var(--color-accent);
  border-radius: var(--radius-loader);
  animation: publication-spin .8s linear infinite;
}

.visual-loader {
  display: grid;
  min-height: 150px;
  margin-block: var(--space-xl);
  place-items: center;
  background: var(--color-soft);
}
.visual-loader .loading-indicator { width: 22px; height: 22px; }
@keyframes publication-spin { to { transform: rotate(360deg); } }

.publication-source {
  width: min(100%, var(--evidence));
  margin-inline: auto;
  padding: var(--space-lg);
  overflow-wrap: anywhere;
  border-radius: var(--radius-small);
  background: var(--color-source);
  color: var(--color-source-ink);
  white-space: pre-wrap;
  font: var(--text-sm)/1.65 var(--font-mono);
}

h1, h2, h3, h4 {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--color-ink-strong);
  font-style: normal;
  text-wrap: balance;
  scroll-margin-top: var(--space-xl);
}
h2, h3 { transition: background-color var(--dur-fast) var(--ease-out); }

.heading-permalink {
  display: inline-grid;
  width: 2.5rem;
  height: 2.5rem;
  margin-inline-start: var(--space-2xs);
  place-items: center;
  vertical-align: .08em;
  color: var(--color-muted);
  opacity: 0;
  text-decoration: none;
  transition-property: color, opacity;
  transition-duration: var(--dur-fast);
  transition-timing-function: var(--ease-out);
}
.heading-permalink svg { width: 1rem; height: 1rem; }
h2:hover .heading-permalink,
h3:hover .heading-permalink,
.heading-permalink:focus-visible { opacity: 1; }
.heading-permalink:hover { color: var(--color-accent); }

h1, h2 { font-family: var(--font-display); }
h3, h4 { font-family: var(--font-body); }

h1 {
  margin-block: var(--space-lg) var(--space-lg);
  padding-block: var(--space-lg) var(--space-xl);
  font-size: var(--text-display);
  font-weight: 700;
  line-height: 1.02;
  letter-spacing: -.03em;
}

h2 {
  margin-block: var(--space-3xl) var(--space-lg);
  font-size: clamp(1.8rem, 3vw, 2.45rem);
  font-weight: 700;
  line-height: 1.14;
  letter-spacing: -.02em;
}

h3 {
  margin-block: var(--space-2xl) var(--space-sm);
  font-size: var(--text-lg);
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -.012em;
}
h4 {
  margin-block: var(--space-xl) var(--space-xs);
  font-size: 1.08rem;
  font-weight: 700;
  letter-spacing: .01em;
}

p { margin-block: 0 var(--space-lg); text-wrap: pretty; }
.publication > h1 + p,
.article-opening > h1 + p {
  margin-block-end: var(--space-2xl);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: clamp(1.15rem, 1.6vw, 1.32rem);
  font-weight: 500;
  line-height: 1.58;
}
.section-deck {
  margin-block-end: var(--space-xl);
  color: var(--color-ink);
  font-size: clamp(1.08rem, 1.3vw, 1.22rem);
  font-weight: 500;
  line-height: 1.58;
}

ul, ol {
  margin-block: var(--space-xs) var(--space-lg);
  padding-inline-start: var(--space-lg);
}
li { text-wrap: pretty; }
li + li { margin-block-start: var(--space-xs); }
strong { color: var(--color-ink-strong); font-weight: 700; }
hr {
  margin-block: var(--space-2xl);
  border: 0;
  border-block-start: var(--rule-hair) solid var(--color-line-strong);
}

code {
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: .91em;
  text-autospace: no-autospace;
}
:not(pre) > code {
  padding: var(--space-3xs) var(--space-2xs);
  border-radius: .2rem;
  background: var(--color-inline-code);
  color: var(--color-inline-code-ink);
  font-weight: 500;
}

pre {
  margin-block: var(--space-lg) var(--space-xl);
  padding: var(--space-lg);
  overflow: auto;
  border: var(--rule-hair) solid var(--color-line);
  border-radius: var(--radius-medium);
  background: var(--color-code);
  color: var(--color-code-ink);
  font: var(--text-sm)/1.62 var(--font-mono);
  tab-size: 2;
}
pre code { font: inherit; }
.hljs-comment,
.hljs-quote { color: var(--color-code-muted); }
.hljs-keyword,
.hljs-selector-tag,
.hljs-literal,
.hljs-section,
.hljs-link { color: var(--color-code-keyword); }
.hljs-title,
.hljs-function,
.hljs-class,
.hljs-name,
.hljs-type,
.hljs-built_in { color: var(--color-code-title); }
.hljs-string,
.hljs-regexp,
.hljs-attribute,
.hljs-template-tag,
.hljs-template-variable { color: var(--color-code-string); }
.hljs-number,
.hljs-symbol,
.hljs-bullet,
.hljs-variable,
.hljs-attr,
.hljs-meta { color: var(--color-code-number); }
.hljs-addition { color: var(--color-code-string); }
.hljs-deletion { color: var(--color-code-keyword); }
.hljs-strong { font-weight: 700; }
.hljs-emphasis { font-style: normal; }

.katex {
  color: var(--color-ink-strong);
  font-size: 1.04em;
  text-autospace: no-autospace;
}
.katex-block {
  margin-block: var(--space-xl);
  padding-block: var(--space-xs);
  overflow-x: auto;
  overflow-y: hidden;
  color: var(--color-ink-strong);
  line-height: 1.35;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
  text-align: center;
}
.katex-block .katex-display {
  width: max-content;
  min-width: 100%;
  margin: 0;
}
.katex-error {
  color: var(--color-danger);
  font-family: var(--font-mono);
  font-size: .91em;
  overflow-wrap: anywhere;
}
.katex-source {
  font-family: var(--font-mono);
  font-size: .91em;
}
.katex-block.katex-source {
  text-align: start;
  white-space: pre;
}

blockquote {
  margin-block: var(--space-xl);
  padding: var(--space-lg);
  background: var(--color-soft);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: 1.15em;
  line-height: 1.58;
}
blockquote > :last-child { margin-block-end: 0; }

.markdown-alert {
  margin-block: var(--space-xl);
  padding: var(--space-md) var(--space-lg);
  border-inline-start: var(--rule-hair) solid var(--color-accent);
  border-radius: var(--radius-medium);
  background: color-mix(in oklab, var(--color-accent-soft) 58%, var(--color-page));
}
.markdown-alert-title {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-block-end: var(--space-xs);
  color: var(--color-accent);
  font-family: var(--font-body);
  font-size: .8125rem;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: .045em;
  text-transform: uppercase;
}
.markdown-alert-title svg {
  width: 1em;
  height: 1em;
  fill: currentColor;
}
.markdown-alert > :last-child { margin-block-end: 0; }
.markdown-alert-warning {
  border-inline-start-color: var(--color-warning);
  background: color-mix(in oklab, var(--color-warning-soft) 58%, var(--color-page));
}
.markdown-alert-warning .markdown-alert-title { color: var(--color-warning); }
.markdown-alert-caution {
  border-inline-start-color: var(--color-danger);
  background: color-mix(in oklab, var(--color-danger-soft) 58%, var(--color-page));
}
.markdown-alert-caution .markdown-alert-title { color: var(--color-danger); }
.markdown-alert-tip {
  border-inline-start-color: var(--color-tip);
  background: color-mix(in oklab, var(--color-tip-soft) 58%, var(--color-page));
}
.markdown-alert-tip .markdown-alert-title { color: var(--color-tip); }

.table-wrap {
  width: fit-content;
  max-width: 100%;
  margin-block: var(--space-lg) var(--space-xl);
  overflow-x: auto;
  border: var(--rule-hair) solid var(--color-line);
  border-radius: .75rem;
  background: var(--color-paper);
}
.publication > .table-wrap,
.article-opening > .table-wrap,
.article-body > .table-wrap {
  width: fit-content;
  max-width: min(100%, var(--reading));
  margin-inline-start: var(--reading-inset);
  margin-inline-end: 0;
}
.publication > .table-wrap.width-medium,
.article-opening > .table-wrap.width-medium,
.article-body > .table-wrap.width-medium {
  max-width: min(var(--medium), calc(100% - var(--reading-inset)));
}
.publication > .table-wrap.width-evidence,
.article-opening > .table-wrap.width-evidence,
.article-body > .table-wrap.width-evidence {
  max-width: min(var(--evidence), calc(100% - var(--reading-inset)));
}
table {
  width: auto;
  max-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: transparent;
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: .9em;
  line-height: 1.48;
  font-variant-numeric: tabular-nums;
}
th, td {
  min-width: 9rem;
  padding: var(--space-sm) var(--space-md);
  border-block-end: var(--rule-hair) solid color-mix(in oklab, var(--color-line) 72%, var(--color-paper));
  overflow-wrap: anywhere;
  text-align: start;
  vertical-align: top;
}
th {
  border-block-end-color: var(--color-line);
  background: color-mix(in oklab, var(--color-soft) 52%, var(--color-paper));
  color: var(--color-ink-strong);
  font-weight: 650;
  letter-spacing: 0;
}
@media (hover: hover) and (pointer: fine) {
  tbody tr:hover {
    background: color-mix(in oklab, var(--color-soft) 34%, var(--color-paper));
  }
}
tr:last-child td { border-block-end: 0; }

.article-nav {
  display: block;
  min-width: 0;
  width: min(100%, var(--reading));
  margin: 0 auto var(--space-xl);
  padding-block: var(--space-xs) var(--space-lg);
  overflow-x: hidden;
}
.article-nav[hidden] { display: none; }
.article-nav-disclosure {
  border-block: var(--rule-hair) solid var(--color-line);
}
.article-nav-summary {
  min-height: 44px;
  padding-block: var(--space-sm);
  color: var(--color-ink-strong);
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: 700;
  line-height: 1.4;
  text-wrap: pretty;
}
.article-nav-disclosure[open] .article-nav-summary {
  color: var(--color-accent);
}
.article-nav-links { padding-block: var(--space-2xs); }
.article-nav a {
  display: block;
  min-width: 0;
  max-width: 100%;
  min-height: 44px;
  padding: var(--space-sm) var(--space-xs);
  color: var(--color-muted);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  line-height: 1.35;
  overflow-wrap: anywhere;
  text-decoration: none;
  text-wrap: pretty;
  white-space: normal;
  transition: color var(--dur-fast) var(--ease-out);
}
.article-nav a:hover { color: var(--color-accent); }
.article-nav a.article-nav-subsection {
  padding-inline-start: var(--space-md);
  font-size: .8125rem;
}
.article-nav a[aria-current="location"] {
  color: var(--color-ink-strong);
  font-weight: 700;
}

.evidence-figure {
  margin-block: var(--space-xl) var(--space-2xl);
  padding-block: var(--space-lg);
}
.article-opening > .opening-lead { margin-block-start: var(--space-2xl); }
.article-opening > :is(.evidence-figure, .table-wrap).opening-lead { margin-block-end: 0; }
.article-opening > p.opening-lead {
  width: min(var(--medium), calc(100% - var(--reading-inset)));
  margin-inline-start: var(--reading-inset);
  margin-inline-end: 0;
}
.article-opening > p.opening-lead img {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: min(62vh, 42rem);
  margin-inline: auto;
  object-fit: contain;
}
.article-opening .mermaid-figure.opening-lead .figure-scroll {
  max-height: min(62vh, 42rem);
  overflow: auto;
}
.evidence-caption,
.evidence-note {
  width: min(100%, var(--reading));
  margin-inline: 0;
}
.evidence-caption {
  margin-block: 0 var(--space-lg);
  color: var(--color-muted);
  font-size: .95rem;
  line-height: 1.55;
  text-wrap: pretty;
}
.evidence-caption strong:first-child {
  display: block;
  margin-block-end: var(--space-2xs);
  color: var(--color-ink-strong);
  font-size: 1.08rem;
  line-height: 1.4;
}
.evidence-note {
  margin-block: var(--space-sm) 0;
  color: var(--color-muted);
  font-size: var(--text-sm);
  line-height: 1.55;
  text-wrap: pretty;
}
.evidence-note strong { color: var(--color-ink); }
.table-figure > .table-wrap { margin-block: 0; }
.figure-scroll { overflow-x: auto; }
.mermaid-zoom-surface {
  display: block;
  width: 100%;
  max-width: 100%;
  padding: 0;
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: inherit;
  cursor: zoom-in;
}
.mermaid-figure svg {
  display: block;
  width: auto;
  max-width: none;
  height: auto;
  margin-inline: auto;
}
.mermaid-dialog-close {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  padding: 0;
  place-items: center;
  border: 0;
  background: var(--color-paper);
  color: var(--color-muted);
  cursor: pointer;
  transition-property: color, background-color;
  transition-duration: var(--dur-fast);
  transition-timing-function: var(--ease-out);
}
.mermaid-dialog-close svg { width: 1rem; height: 1rem; }
.mermaid-dialog-close:hover {
  background: var(--color-soft);
  color: var(--color-accent);
  opacity: 1;
}
html.has-mermaid-dialog { overflow-y: clip; }
.mermaid-dialog[open] {
  display: grid;
  width: 100vw;
  max-width: none;
  height: 100vh;
  max-height: none;
  margin: 0;
  padding: clamp(var(--space-xs), 2vw, var(--space-xl));
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--color-ink);
}
.mermaid-dialog::backdrop {
  background: transparent;
  transition: background-color 150ms var(--ease-out);
}
.mermaid-dialog.is-visible::backdrop {
  background: oklch(17% .014 255 / .28);
  transition-duration: 200ms;
}
.mermaid-dialog-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(100%, var(--evidence));
  height: min(100%, 64rem);
  min-width: 0;
  min-height: 0;
  background: var(--color-paper);
  box-shadow: 0 1.5rem 5rem oklch(17% .014 255 / .16);
  opacity: 0;
  transform: translateY(.5rem) scale(.985);
  transition-property: transform, opacity;
  transition-duration: 150ms;
  transition-timing-function: var(--ease-out);
}
.mermaid-dialog.is-visible .mermaid-dialog-panel {
  opacity: 1;
  transform: translateY(0) scale(1);
  transition-duration: 200ms;
}
.mermaid-dialog-bar {
  display: flex;
  min-height: 3.5rem;
  align-items: center;
  justify-content: flex-end;
  padding-inline: var(--space-xs);
  border-block-end: var(--rule-hair) solid var(--color-line);
}
.mermaid-dialog-viewport {
  min-width: 0;
  min-height: 0;
  padding: var(--space-lg);
  overflow: auto;
  overscroll-behavior: contain;
}
.mermaid-dialog-viewport > svg {
  display: block;
  width: max(100%, var(--mermaid-zoom-width, 720px));
  max-width: none;
  height: auto;
  margin: auto;
}
.echarts-mount { width: 100%; min-height: 340px; }
.interactive-stage {
  position: relative;
  min-height: 20rem;
}
.interactive-stage > .visual-loader {
  position: absolute;
  z-index: 1;
  inset: 0;
  min-height: 0;
  margin: 0;
}
.interactive-frame {
  display: block;
  width: 100%;
  height: 20rem;
  min-height: 15rem;
  border: var(--rule-hair) solid var(--color-line);
  border-radius: .75rem;
  background: var(--color-paper);
  opacity: 0;
  transition: opacity var(--dur-long) var(--ease-out);
}
.interactive-stage.is-ready .interactive-frame { opacity: 1; }
.chart-data {
  width: min(100%, var(--reading));
  margin: var(--space-sm) 0 0;
  color: var(--color-muted);
  font-family: var(--font-body);
  font-size: var(--text-sm);
}
.chart-data summary {
  min-height: 40px;
  cursor: pointer;
  width: fit-content;
  color: var(--color-accent);
  line-height: 40px;
  white-space: nowrap;
}
.chart-data summary:active { color: var(--color-ink-strong); }
.chart-data .table-wrap {
  margin-block-start: var(--space-xs);
  margin-block-end: 0;
  background: var(--color-paper);
}

img {
  max-width: 100%;
  height: auto;
}

@media (min-width: 40rem) {
  body { font-size: 17px; }
  .publication { font-size: 1.125rem; }
  .page-shell {
    padding: var(--space-2xl) clamp(var(--space-lg), 5vw, var(--space-3xl)) var(--space-4xl);
  }
  th, td { min-width: 0; }
}

:root[data-language="zh-CN"] .publication,
:root[data-language="ja"] .publication,
:root[data-language="ko"] .publication {
  line-height: 1.8;
  text-autospace: normal;
}

:root[data-language="zh-CN"] h1,
:root[data-language="ja"] h1,
:root[data-language="ko"] h1 {
  line-height: 1.1;
  letter-spacing: -.015em;
}

:root[data-language="zh-CN"] h1,
:root[data-language="zh-CN"] h2,
:root[data-language="zh-CN"] h3 { letter-spacing: 0; }

@media (min-width: 85rem) {
  .page-shell.has-toc .article-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, var(--reading)) minmax(0, 1fr);
    align-items: start;
  }
  .page-shell.has-toc .article-body {
    grid-column: 1 / -1;
    grid-row: 1;
    min-width: 0;
  }
  .page-shell.has-toc .article-layout > .article-nav {
    grid-column: 1;
    grid-row: 1;
    position: sticky;
    z-index: 1;
    top: var(--space-xl);
    justify-self: end;
    align-self: start;
    width: var(--toc);
    max-height: calc(100dvh - var(--space-xl));
    margin: 0;
    margin-inline-end: var(--toc-gap);
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .page-shell.has-toc .article-layout > .article-nav::-webkit-scrollbar { display: none; }
  .page-shell.has-toc .article-nav-disclosure { border: 0; }
  .page-shell.has-toc .article-nav-summary { display: none; }
  .page-shell.has-toc .article-nav-links { padding-block: 0 var(--space-xs); }
  .page-shell.has-toc .article-nav a {
    min-height: 0;
    padding-block: .625rem;
    padding-inline: 0;
    line-height: 1.32;
  }
  .page-shell.has-toc .article-nav a.article-nav-section {
    font-weight: 650;
  }
  .page-shell.has-toc .article-nav a.article-nav-section:not(:first-child) {
    margin-block-start: var(--space-sm);
  }
  .page-shell.has-toc .article-nav a.article-nav-subsection {
    padding-block: .375rem;
    padding-inline-start: var(--space-sm);
  }
}

@media (pointer: coarse) {
  .article-nav a,
  .chart-data summary { min-height: 44px; }
  .heading-permalink,
  .citation-backlink { width: 2.75rem; height: 2.75rem; opacity: 1; }
  .citation-backlink::before { inset: 0; }
  .mermaid-dialog-close { width: 2.75rem; height: 2.75rem; opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  body.is-ready .publication { animation: none; }
  .loading-indicator { animation: none; }
  .article-nav a,
  .heading-permalink,
  .citation,
  .mermaid-dialog::backdrop,
  .mermaid-dialog.is-visible::backdrop,
  .mermaid-dialog-panel,
  .mermaid-dialog.is-visible .mermaid-dialog-panel,
  .interactive-frame,
  h2,
  h3,
  [id^="source-"] { transition: none; }
}

@media print {
  .article-nav,
  .mermaid-dialog,
  .interactive-figure,
  .citation-preview { display: none !important; }
}
`;
