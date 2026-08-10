import { task, z } from "acpus/core";

import { PUBLICATION_STYLE } from "./publication-theme.js";

const RenderPublicationInput = z.object({
  completed: z.boolean(),
  editorialPath: z.string(),
  htmlPath: z.string(),
});

type RenderPublicationInput = z.infer<typeof RenderPublicationInput>;

type RenderedPublication = {
  htmlPath: string;
};

const MARKDOWN_IT_URL = "https://cdn.jsdelivr.net/npm/markdown-it@15.0.0/+esm";
const ALERTS_URL = "https://cdn.jsdelivr.net/npm/markdown-it-github-alerts@1.0.1/+esm";
const HIGHLIGHT_JS_URL = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/es/highlight.min.js";
const KATEX_PLUGIN_URL = "https://cdn.jsdelivr.net/npm/@mdit/plugin-katex@1.0.2/+esm";
const TEX_PLUGIN_URL = "https://cdn.jsdelivr.net/npm/@mdit/plugin-tex@1.0.2/+esm";
const KATEX_STYLE_URL = "https://cdn.jsdelivr.net/npm/katex@0.18.1/dist/katex-swap.min.css";
const BEAUTIFUL_MERMAID_URL = "https://cdn.jsdelivr.net/npm/beautiful-mermaid@1.1.3/+esm";
const ECHARTS_URL = "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.esm.min.js";
const MONO_FONT_URL = "https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/index.css";

const CLIENT_SCRIPT = String.raw`
const MARKDOWN_IT_URL = "${MARKDOWN_IT_URL}";
const ALERTS_URL = "${ALERTS_URL}";
const HIGHLIGHT_JS_URL = "${HIGHLIGHT_JS_URL}";
const KATEX_PLUGIN_URL = "${KATEX_PLUGIN_URL}";
const TEX_PLUGIN_URL = "${TEX_PLUGIN_URL}";
const KATEX_STYLE_URL = "${KATEX_STYLE_URL}";
const BEAUTIFUL_MERMAID_URL = "${BEAUTIFUL_MERMAID_URL}";
const ECHARTS_URL = "${ECHARTS_URL}";
const MONO_FONT_URL = "${MONO_FONT_URL}";
const MARKDOWN_TIMEOUT_MS = 12000;
const OPTIONAL_PLUGIN_TIMEOUT_MS = 4000;
const VISUAL_TIMEOUT_MS = 15000;
const MERMAID_DIALOG_CLOSE_FALLBACK_MS = 250;

const article = document.getElementById("publication");
const pageLoader = document.getElementById("publication-loader");
const sourceElement = document.getElementById("publication-source");
const source = sourceElement ? sourceElement.textContent || "" : "";
const targetTimers = new WeakMap();
const interactiveFrames = new Map();
window.addEventListener("message", handleInteractiveMessage);
let mermaidLightbox;
const colorCanvas = document.createElement("canvas");
colorCanvas.width = 1;
colorCanvas.height = 1;
const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });

const language = detectLanguage(source);
document.documentElement.lang = language;
document.documentElement.dataset.language = language;
pageLoader?.setAttribute("aria-label", loadingLabel("report"));
loadFonts();

try {
  const alertsPromise = withTimeout(import(ALERTS_URL), OPTIONAL_PLUGIN_TIMEOUT_MS, "Callout plugin timed out.")
    .catch(error => {
      console.warn("Research report callouts remained ordinary blockquotes.", error);
      return null;
    });
  const highlightPromise = containsHighlightableFence(source)
    ? withTimeout(import(HIGHLIGHT_JS_URL), OPTIONAL_PLUGIN_TIMEOUT_MS, "Syntax highlighter timed out.")
      .catch(error => {
        console.warn("Research report code remained unhighlighted.", error);
        return null;
      })
    : Promise.resolve(null);
  const hasMath = containsMath(source);
  const mathPromise = hasMath
    ? withTimeout(import(KATEX_PLUGIN_URL), OPTIONAL_PLUGIN_TIMEOUT_MS, "Formula renderer timed out.")
      .catch(error => {
        console.warn("Research report formulas remained TeX source.", error);
        return null;
      })
    : Promise.resolve(null);
  const texPromise = hasMath
    ? withTimeout(import(TEX_PLUGIN_URL), OPTIONAL_PLUGIN_TIMEOUT_MS, "Formula source parser timed out.")
      .catch(() => null)
    : Promise.resolve(null);
  const mathStylePromise = hasMath
    ? withTimeout(loadStylesheet(KATEX_STYLE_URL), OPTIONAL_PLUGIN_TIMEOUT_MS, "Formula styles timed out.")
      .then(() => true)
      .catch(error => {
        document.querySelector('link[href="' + KATEX_STYLE_URL + '"]')?.remove();
        console.warn("Research report formulas are using native MathML.", error);
        return false;
      })
    : Promise.resolve(false);
  const markdownModule = await withTimeout(import(MARKDOWN_IT_URL), MARKDOWN_TIMEOUT_MS, "Markdown renderer timed out.");
  const MarkdownIt = markdownModule.default;
  const [alertsModule, highlightModule, mathModule, texModule, mathStylesLoaded] = await Promise.all([
    alertsPromise,
    highlightPromise,
    mathPromise,
    texPromise,
    mathStylePromise,
  ]);
  const highlighter = highlightModule?.default;
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight: (code, declaredLanguage) => highlightCode(code, declaredLanguage, highlighter),
  });
  installHeadingIds(markdown);
  if (alertsModule) markdown.use(alertsModule.default);
  if (typeof mathModule?.katex === "function") {
    markdown.use(mathModule.katex, {
      allowInlineWithSpace: false,
      delimiters: "all",
      mathFence: false,
      maxExpand: 1000,
      maxSize: 20,
      output: mathStylesLoaded ? "htmlAndMathml" : "mathml",
      throwOnError: false,
      trust: false,
    });
  } else if (typeof texModule?.tex === "function") {
    markdown.use(texModule.tex, {
      allowInlineWithSpace: false,
      delimiters: "all",
      mathFence: false,
      render: (content, displayMode) => {
        const escaped = markdown.utils.escapeHtml(content);
        return displayMode
          ? "<p class=\"katex-block katex-source\">" + escaped + "</p>\n"
          : "<code class=\"katex-source\">" + escaped + "</code>";
      },
    });
  }

  const rendered = markdown.render(source);
  article.innerHTML = rendered;
  document.title = article.querySelector("h1")?.textContent?.trim() || "Research report";
  normalizeArticle();
  const visualJobs = [renderMermaidBlocks(), renderEChartsBlocks(), renderInteractiveBlocks()];
  finishPageLoading();
  await Promise.allSettled(visualJobs);
} catch (error) {
  if (sourceElement && !sourceElement.isConnected) article.replaceChildren(sourceElement);
  finishPageLoading();
  console.warn("Research report Markdown could not be rendered; preserving its source.", error);
}

function finishPageLoading() {
  document.body.classList.remove("is-loading");
  document.body.classList.add("is-ready");
  if (pageLoader) pageLoader.hidden = true;
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadingLabel(kind) {
  const labels = {
    "zh-CN": { report: "正在排版报告", diagram: "正在绘制关系图", chart: "正在绘制定量图", interactive: "正在加载交互内容" },
    ja: { report: "レポートを整形中", diagram: "図を描画中", chart: "チャートを描画中", interactive: "インタラクティブコンテンツを読み込み中" },
    ko: { report: "보고서 서식 지정 중", diagram: "다이어그램 렌더링 중", chart: "차트 렌더링 중", interactive: "인터랙티브 콘텐츠 로드 중" },
    en: { report: "Formatting report", diagram: "Rendering diagram", chart: "Rendering chart", interactive: "Loading interactive content" },
  };
  return labels[language]?.[kind] || labels.en[kind];
}

function detectLanguage(text) {
  if (/[가-힯]/u.test(text)) return "ko";
  if (/[぀-ヿ]/u.test(text)) return "ja";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  return "en";
}

function containsMath(text) {
  if (/(?:^|\n)[ \t>]*(?:\$\$(?!\$)|\\\[)/u.test(text)) return true;
  if (/\\\((?:\\.|[^\\\n])*?\\\)/u.test(text)) return true;
  return /(^|[^\\$A-Za-z0-9_])\$(?![\s$])(?:\\.|[^$\n])*?[^\s\\$]\$(?![$A-Za-z0-9_])/u.test(text);
}

function containsHighlightableFence(text) {
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^[ ]{0,3}(?:\u0060{3,}|~{3,})[ \t]*([^\s\u0060~]+)/u);
    if (!match) continue;
    const declaredLanguage = match[1].toLowerCase();
    if (declaredLanguage !== "mermaid" && declaredLanguage !== "echarts" && declaredLanguage !== "interactive") return true;
  }
  return false;
}

function loadStylesheet(url) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error("Stylesheet could not load."));
    }, { once: true });
    document.head.append(link);
  });
}

function loadFonts() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = MONO_FONT_URL;
  document.head.append(link);
}

function installHeadingIds(markdown) {
  const seen = new Map();
  markdown.renderer.rules.heading_open = (tokens, index, options, env, self) => {
    const title = tokens[index + 1]?.content || "section";
    const base = title.normalize("NFKC").trim().toLowerCase()
      .replace(/\s+/gu, "-")
      .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "section";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    tokens[index].attrSet("id", count === 0 ? base : base + "-" + (count + 1));
    return self.renderToken(tokens, index, options);
  };
}

function highlightCode(code, declaredLanguage, highlighter) {
  const name = (declaredLanguage || "").trim().split(/\s+/u)[0].toLowerCase();
  if (!name || !highlighter?.getLanguage?.(name) || typeof highlighter.highlight !== "function") return "";
  try {
    return highlighter.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch (error) {
    console.warn("A code block could not be highlighted; preserving escaped code.", error);
    return "";
  }
}

function normalizeArticle() {
  for (const alert of article.querySelectorAll(".markdown-alert")) {
    const aside = document.createElement("aside");
    aside.className = alert.className;
    aside.setAttribute("role", "note");
    aside.append(...alert.childNodes);
    alert.replaceWith(aside);
  }

  const codeLabels = {
    "zh-CN": index => "可横向滚动的代码，第 " + index + " 段",
    ja: index => "横スクロール可能なコード " + index,
    ko: index => "가로로 스크롤할 수 있는 코드 " + index,
    en: index => "Scrollable code " + index,
  };
  const codeRegions = [...article.querySelectorAll("pre")];
  for (const [index, pre] of codeRegions.entries()) {
    pre.classList.add("width-medium");
    pre.tabIndex = 0;
    pre.setAttribute("role", "region");
    pre.setAttribute("aria-label", (codeLabels[language] || codeLabels.en)(index + 1));
  }

  const formulaLabels = {
    "zh-CN": index => "可横向滚动的公式，第 " + index + " 个",
    ja: index => "横スクロール可能な数式 " + index,
    ko: index => "가로로 스크롤할 수 있는 수식 " + index,
    en: index => "Scrollable formula " + index,
  };
  const formulaRegions = [...article.querySelectorAll(".katex-block")];
  for (const [index, formula] of formulaRegions.entries()) {
    formula.tabIndex = 0;
    formula.setAttribute("role", "region");
    formula.setAttribute("aria-label", (formulaLabels[language] || formulaLabels.en)(index + 1));
  }

  for (const table of article.querySelectorAll("table")) {
    let wrap = table.parentElement?.classList.contains("table-wrap") ? table.parentElement : undefined;
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.before(wrap);
      wrap.append(table);
    }
    wrap.classList.remove("width-medium", "width-evidence");
    const widthClass = tableWidthClass(table);
    if (widthClass) wrap.classList.add(widthClass);
    prepareTableRegion(wrap);
  }

  for (const wrap of article.querySelectorAll(":scope > .table-wrap")) {
    const context = evidenceContext(wrap);
    if (!context.caption && !context.note) continue;
    const widthClass = wrap.classList.contains("width-evidence")
      ? "width-evidence"
      : wrap.classList.contains("width-medium") ? "width-medium" : "";
    const figure = document.createElement("figure");
    figure.className = "evidence-figure table-figure" + (widthClass ? " " + widthClass : "");
    wrap.before(figure);
    wrap.classList.remove("width-medium", "width-evidence");
    appendEvidenceCaption(figure, context);
    figure.append(wrap);
    appendEvidenceNote(figure, context);
  }

  for (const link of article.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) continue;
    if (safeLink(href) === undefined) {
      link.removeAttribute("href");
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  for (const image of article.querySelectorAll("img[src]")) {
    const src = image.getAttribute("src") || "";
    const safe = safeImage(src);
    if (safe === undefined) image.replaceWith(document.createTextNode(image.getAttribute("alt") || ""));
    else image.setAttribute("src", safe);
  }

  linkCitationMarkers();

  const sections = [...article.querySelectorAll(":scope > h2")];
  for (const heading of sections) {
    if (heading.nextElementSibling?.tagName === "P") heading.nextElementSibling.classList.add("section-deck");
  }
  wrapArticleOpening(sections[0]);
  const navigationHeadings = [...article.querySelectorAll(":scope > h2, :scope > h3")];
  buildArticleNavigation(sections, navigationHeadings);
  installHeadingPermalinks(article.querySelectorAll("h2, h3"));
  installTargetFeedback();
}

function wrapArticleOpening(firstSection) {
  const title = article.querySelector(":scope > h1");
  if (!title || !firstSection) return;
  const opening = document.createElement("header");
  opening.className = "article-opening";
  title.before(opening);
  for (let node = opening.nextSibling; node && node !== firstSection;) {
    const next = node.nextSibling;
    opening.append(node);
    node = next;
  }
  classifyArticleOpening();
  new MutationObserver(classifyArticleOpening).observe(opening, { childList: true });
}

function classifyArticleOpening() {
  const opening = article.querySelector(":scope > .article-opening");
  if (!opening) return;
  opening.classList.remove("article-opening--text", "article-opening--lead");
  for (const element of opening.querySelectorAll(":scope > .opening-lead")) element.classList.remove("opening-lead");
  const lead = [...opening.children].find(isOpeningLead);
  if (!lead) {
    opening.classList.add("article-opening--text");
    return;
  }
  lead.classList.add("opening-lead");
  opening.classList.add("article-opening--lead");
}

function isOpeningLead(element) {
  if (element.matches(".markdown-alert, .table-wrap, .evidence-figure:not(.interactive-figure), ul, ol")) return true;
  return element.tagName === "P" && element.querySelector("img") !== null;
}

function buildArticleNavigation(sections, headings) {
  if (sections.length < 5 || headings.length === 0) return;
  const nav = document.getElementById("article-nav");
  if (!nav) return;
  const labels = { "zh-CN": "本文目录", ja: "目次", ko: "목차", en: "Article sections" };
  const label = labels[language] || labels.en;
  nav.setAttribute("aria-label", label);
  const disclosure = document.createElement("details");
  disclosure.className = "article-nav-disclosure";
  const summary = document.createElement("summary");
  summary.className = "article-nav-summary";
  summary.textContent = label;
  const linksContainer = document.createElement("div");
  linksContainer.className = "article-nav-links";
  const links = new Map();
  for (const heading of headings) {
    const link = document.createElement("a");
    link.className = heading.tagName === "H3" ? "article-nav-subsection" : "article-nav-section";
    link.href = "#" + heading.id;
    link.textContent = heading.textContent || heading.id;
    links.set(heading.id, link);
    linksContainer.append(link);
  }
  disclosure.append(summary, linksContainer);
  nav.replaceChildren(disclosure);
  nav.hidden = false;

  const layout = document.createElement("div");
  layout.className = "article-layout";
  const body = document.createElement("div");
  body.className = "article-body";
  sections[0].before(layout);
  for (let sibling = layout.nextSibling; sibling;) {
    const next = sibling.nextSibling;
    body.append(sibling);
    sibling = next;
  }
  layout.append(nav, body);

  const pageShell = document.querySelector(".page-shell");
  pageShell?.classList.add("has-toc");
  const wideNavigation = window.matchMedia("(min-width: 85rem)");
  const setNavigationMode = isWide => {
    if (isWide) {
      disclosure.open = true;
      if (document.activeElement === summary) links.values().next().value?.focus();
      return;
    }
    if (nav.contains(document.activeElement) && document.activeElement !== summary) summary.focus();
    disclosure.open = false;
  };
  setNavigationMode(wideNavigation.matches);
  wideNavigation.addEventListener?.("change", event => setNavigationMode(event.matches));

  let current;
  const setCurrent = heading => {
    if (!heading || current === heading.id) return;
    for (const link of links.values()) link.removeAttribute("aria-current");
    links.get(heading.id)?.setAttribute("aria-current", "location");
    current = heading.id;
  };
  setCurrent(headings[0]);
  nav.addEventListener("click", event => {
    const link = event.target.closest?.("a[href^='#']");
    if (!link) return;
    setCurrent(headings.find(heading => "#" + heading.id === link.getAttribute("href")));
    if (!wideNavigation.matches) disclosure.open = false;
  });
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible.length > 0) setCurrent(visible[0].target);
    }, { rootMargin: "-10% 0px -80% 0px", threshold: 0 });
    for (const heading of headings) observer.observe(heading);
  }
}

function installHeadingPermalinks(headings) {
  const labels = {
    "zh-CN": title => "链接到“" + title + "”",
    ja: title => "「" + title + "」へのリンク",
    ko: title => "‘" + title + "’ 섹션 링크",
    en: title => "Link to “" + title + "”",
  };
  for (const heading of headings) {
    const title = heading.textContent?.trim() || heading.id;
    heading.tabIndex = -1;
    const link = document.createElement("a");
    link.className = "heading-permalink";
    link.href = "#" + heading.id;
    link.setAttribute("aria-label", (labels[language] || labels.en)(title));
    link.append(svgIcon([
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ]));
    heading.append(link);
  }
}

function linkCitationMarkers() {
  const sourceHeading = [...article.querySelectorAll("h2, h3")].reverse().find(heading =>
    /(?:来源|参考文献|出典|출처|참고|sources?|references?)/iu.test(heading.textContent || ""),
  );
  if (!sourceHeading) return;

  const sources = new Map();
  const sourceItems = new Map();
  const sourceLevel = Number(sourceHeading.tagName.slice(1));
  for (let sibling = sourceHeading.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    const siblingLevel = /^H[1-6]$/u.test(sibling.tagName) ? Number(sibling.tagName.slice(1)) : undefined;
    if (siblingLevel !== undefined && siblingLevel <= sourceLevel) break;
    for (const item of sibling.matches("li") ? [sibling] : sibling.querySelectorAll("li")) {
      stripLegacySourceAnchor(item);
      const match = (item.textContent || "").match(/^\s*\[([A-Za-z][A-Za-z0-9._:-]*)\]/u);
      if (!match) continue;
      const key = match[1].toUpperCase();
      const id = "source-" + match[1].toLowerCase().replace(/[^a-z0-9_-]+/gu, "-");
      item.id = id;
      item.tabIndex = -1;
      sources.set(key, id);
      sourceItems.set(id, item);
    }
  }
  if (sources.size === 0) return;

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  const citations = new Map();
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("a, code, pre, [id^='source-']")) continue;
    const value = node.data;
    const pattern = /\[([A-Za-z][A-Za-z0-9._:-]*)\]/gu;
    let cursor = 0;
    let changed = false;
    const fragment = document.createDocumentFragment();
    for (const match of value.matchAll(pattern)) {
      const target = sources.get(match[1].toUpperCase());
      if (!target || match.index === undefined) continue;
      fragment.append(document.createTextNode(value.slice(cursor, match.index)));
      const link = document.createElement("a");
      link.className = "citation";
      link.href = "#" + target;
      const refs = citations.get(target) || [];
      link.id = "cite-" + target.slice("source-".length) + "-" + (refs.length + 1);
      link.textContent = match[0];
      link.setAttribute("aria-label", (language === "zh-CN" ? "查看来源 " : "View source ") + match[1]);
      refs.push(link);
      citations.set(target, refs);
      fragment.append(link);
      cursor = match.index + match[0].length;
      changed = true;
    }
    if (!changed) continue;
    fragment.append(document.createTextNode(value.slice(cursor)));
    node.replaceWith(fragment);
  }

  const backlinkLabels = {
    "zh-CN": "返回正文引用",
    ja: "本文の引用に戻る",
    ko: "본문 인용으로 돌아가기",
    en: "Back to citation",
  };
  for (const [target, refs] of citations) {
    const item = sourceItems.get(target);
    if (!item || refs.length === 0) continue;
    const backlink = document.createElement("a");
    backlink.className = "citation-backlink";
    backlink.href = "#" + refs[0].id;
    backlink.setAttribute("aria-label", backlinkLabels[language] || backlinkLabels.en);
    backlink.append(svgIcon(["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 6 6v1"]));
    item.append(document.createTextNode(" "), backlink);
    for (const citation of refs) {
      citation.addEventListener("click", () => { backlink.href = "#" + citation.id; });
    }
  }
  installCitationPreviews(citations, sourceItems);
}

function installCitationPreviews(citations, sourceItems) {
  for (const refs of citations.values()) {
    for (const citation of refs) {
      const target = (citation.getAttribute("href") || "").slice(1);
      const item = sourceItems.get(target);
      if (!item) continue;

      const copy = item.cloneNode(true);
      copy.removeAttribute("id");
      copy.removeAttribute("tabindex");
      for (const element of copy.querySelectorAll("[id], [tabindex]")) {
        element.removeAttribute("id");
        element.removeAttribute("tabindex");
      }
      for (const backlink of copy.querySelectorAll(".citation-backlink")) backlink.remove();

      const host = document.createElement("span");
      host.className = "citation-preview-host";
      const preview = document.createElement("span");
      preview.className = "citation-preview";
      preview.id = citation.id + "-preview";
      preview.setAttribute("role", "note");
      preview.setAttribute("aria-label", citation.getAttribute("aria-label") || citation.textContent || "Source");
      citation.setAttribute("aria-describedby", preview.id);
      const content = document.createElement("span");
      content.className = "citation-preview-content";
      for (const child of [...copy.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE && child.matches("p")) {
          if (content.childNodes.length > 0) content.append(document.createElement("br"));
          content.append(...child.childNodes);
        } else {
          content.append(child);
        }
      }
      preview.append(content);
      citation.before(host);
      host.append(citation, preview);

      const position = () => {
        const citationBox = citation.getBoundingClientRect();
        const previewBox = preview.getBoundingClientRect();
        const margin = 12;
        const below = citationBox.bottom;
        const preferredTop = below + previewBox.height <= window.innerHeight - margin
          ? below
          : citationBox.top - previewBox.height;
        const top = Math.min(
          Math.max(margin, preferredTop),
          Math.max(margin, window.innerHeight - previewBox.height - margin),
        );
        const left = Math.min(
          Math.max(margin, citationBox.left),
          Math.max(margin, window.innerWidth - previewBox.width - margin),
        );
        preview.style.inset = top + "px auto auto " + left + "px";
      };

      host.addEventListener("pointerenter", () => {
        host.classList.remove("is-preview-dismissed");
        position();
      });
      host.addEventListener("pointerleave", () => host.classList.remove("is-preview-dismissed"));
      host.addEventListener("focusin", position);
      host.addEventListener("focusout", event => {
        if (!host.contains(event.relatedTarget)) host.classList.remove("is-preview-dismissed");
      });
      host.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (preview.contains(document.activeElement)) citation.focus();
        host.classList.add("is-preview-dismissed");
      });
    }
  }
}

function stripLegacySourceAnchor(item) {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.data.trim() || node.parentElement?.closest("code, pre")) continue;
    node.data = node.data.replace(
      /^\s*<a\s+id\s*=\s*(["'])([A-Za-z][A-Za-z0-9._:-]*)\1\s*>\s*<\/a\s*>\s*(?=\[\2\])/iu,
      "",
    );
    return;
  }
}

function installTargetFeedback() {
  const resolveTarget = link => {
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("#") || href.length === 1) return undefined;
    try { return document.getElementById(decodeURIComponent(href.slice(1))) || undefined; } catch { return undefined; }
  };
  document.addEventListener("click", event => {
    const link = event.target.closest?.("a[href^='#']");
    const target = link ? resolveTarget(link) : undefined;
    if (!target) return;
    setTimeout(() => {
      target.focus?.({ preventScroll: true });
      pulseTarget(target);
    }, 0);
  });
}

function pulseTarget(target) {
  const previous = targetTimers.get(target);
  if (previous) clearTimeout(previous);
  target.classList.remove("is-targeted");
  requestAnimationFrame(() => {
    target.classList.add("is-targeted");
    targetTimers.set(target, setTimeout(() => target.classList.remove("is-targeted"), 1400));
  });
}

function svgIcon(paths) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const data of paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

async function renderMermaidBlocks() {
  const candidates = [...article.querySelectorAll("pre > code.language-mermaid")].flatMap(block => {
    const pre = block.parentElement;
    return pre ? [{ block, pre, context: evidenceContext(pre), loader: startVisualLoading(pre, "diagram", "width-medium") }] : [];
  });
  if (candidates.length === 0) return;
  let renderMermaidSVG;
  try {
    ({ renderMermaidSVG } = await withTimeout(
      import(BEAUTIFUL_MERMAID_URL),
      VISUAL_TIMEOUT_MS,
      "Beautiful Mermaid timed out.",
    ));
  } catch (error) {
    for (const candidate of candidates) revealVisualSource(candidate);
    console.warn("Beautiful Mermaid could not be loaded; preserving diagram sources.", error);
    return;
  }
  const lightbox = mermaidLightbox || (mermaidLightbox = createMermaidLightbox());

  for (const candidate of candidates) {
    try {
      const svgSource = renderMermaidSVG(candidate.block.textContent || "", {
        bg: resolvedColor("--color-page"),
        fg: resolvedColor("--color-ink"),
        accent: resolvedColor("--color-accent"),
        muted: resolvedColor("--color-muted"),
        surface: resolvedColor("--color-soft"),
        border: resolvedColor("--color-line"),
        font: cssValue("--font-body"),
        transparent: true,
        thoroughness: 3,
      });
      const parsed = new DOMParser().parseFromString(svgSource, "image/svg+xml");
      if (parsed.querySelector("parsererror")) throw new Error("Invalid Beautiful Mermaid SVG.");
      const svg = parsed.documentElement;
      sanitizeSvg(svg);
      const diagramLabel = evidenceLabel(candidate.context) || nearbyHeading(candidate.pre) || "Diagram";
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", diagramLabel);

      const figure = document.createElement("figure");
      figure.className = "evidence-figure mermaid-figure " + mermaidWidthClass(svg);
      const scroll = document.createElement(lightbox ? "button" : "div");
      scroll.className = "figure-scroll";
      const renderedSvg = document.importNode(svg, true);
      if (lightbox) {
        scroll.type = "button";
        scroll.classList.add("mermaid-zoom-surface");
        scroll.setAttribute("aria-label", mermaidZoomLabel(diagramLabel));
        scroll.setAttribute("aria-haspopup", "dialog");
        scroll.addEventListener("click", () => openMermaidLightbox(renderedSvg, diagramLabel, scroll));
      } else {
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", language === "zh-CN" ? "可横向滚动的关系图" : "Scrollable diagram");
      }
      scroll.append(renderedSvg);
      figure.append(scroll);
      appendEvidenceCaption(figure, candidate.context);
      appendEvidenceNote(figure, candidate.context);
      candidate.loader.replaceWith(figure);
      candidate.pre.remove();
    } catch (error) {
      revealVisualSource(candidate);
      console.warn("A Mermaid diagram could not be rendered; preserving its source.", error);
    }
  }
}

function mermaidZoomLabel(label) {
  const labels = {
    "zh-CN": "放大关系图",
    ja: "関係図を拡大",
    ko: "관계도 확대",
    en: "Enlarge diagram",
  };
  return (labels[language] || labels.en) + ": " + label;
}

function openMermaidLightbox(svg, label, opener) {
  const lightbox = mermaidLightbox;
  if (!lightbox || lightbox.dialog.open || !svg.isConnected) return;

  if (!svg.parentElement) return;
  const rect = svg.getBoundingClientRect();
  const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/[ ,]+/u).map(Number);
  const sourceWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : rect.width;
  const zoomWidth = Math.min(2400, Math.max(720, sourceWidth * 1.35));
  lightbox.viewport.style.setProperty("--mermaid-zoom-width", zoomWidth + "px");
  lightbox.viewport.replaceChildren(svg.cloneNode(true));
  lightbox.dialog.setAttribute("aria-label", label);
  lightbox.active = { opener };
  document.documentElement.classList.add("has-mermaid-dialog");

  try {
    lightbox.dialog.classList.remove("is-visible");
    lightbox.dialog.showModal();
    lightbox.viewport.scrollLeft = 0;
    lightbox.viewport.scrollTop = 0;
    lightbox.close.focus({ preventScroll: true });
    if (prefersReducedMotion()) {
      lightbox.dialog.classList.add("is-visible");
    } else {
      lightbox.panel.getBoundingClientRect();
      lightbox.dialog.classList.add("is-visible");
    }
  } catch (error) {
    clearMermaidCloseTimer(lightbox);
    restoreMermaidDiagram(lightbox);
    console.warn("The enlarged Mermaid view could not be opened.", error);
  }
}

function createMermaidLightbox() {
  if (typeof HTMLDialogElement === "undefined" || typeof HTMLDialogElement.prototype.showModal !== "function") return undefined;
  const labels = {
    "zh-CN": { close: "关闭放大的关系图", viewport: "可滚动的放大关系图" },
    ja: { close: "拡大した関係図を閉じる", viewport: "スクロール可能な拡大関係図" },
    ko: { close: "확대한 관계도 닫기", viewport: "스크롤할 수 있는 확대 관계도" },
    en: { close: "Close enlarged diagram", viewport: "Scrollable enlarged diagram" },
  };
  const copy = labels[language] || labels.en;
  const dialog = document.createElement("dialog");
  dialog.id = "mermaid-lightbox";
  dialog.className = "mermaid-dialog";
  const panel = document.createElement("div");
  panel.className = "mermaid-dialog-panel";
  const bar = document.createElement("div");
  bar.className = "mermaid-dialog-bar";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mermaid-dialog-close";
  close.setAttribute("aria-label", copy.close);
  close.append(svgIcon(["M6 6l12 12", "M18 6 6 18"]));
  const viewport = document.createElement("div");
  viewport.className = "mermaid-dialog-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", copy.viewport);
  bar.append(close);
  panel.append(bar, viewport);
  dialog.append(panel);
  const lightbox = { active: undefined, close, closeTimer: undefined, dialog, panel, restoreFocus: true, viewport };
  close.addEventListener("click", () => closeMermaidLightbox(lightbox));
  dialog.addEventListener("click", event => { if (event.target === dialog) closeMermaidLightbox(lightbox); });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeMermaidLightbox(lightbox);
  });
  dialog.addEventListener("close", () => {
    clearMermaidCloseTimer(lightbox);
    dialog.classList.remove("is-visible");
    const restoreFocus = lightbox.restoreFocus;
    lightbox.restoreFocus = true;
    restoreMermaidDiagram(lightbox, restoreFocus);
  });
  window.addEventListener("beforeprint", () => {
    if (!dialog.open) return;
    clearMermaidCloseTimer(lightbox);
    dialog.classList.remove("is-visible");
    restoreMermaidDiagram(lightbox, false);
    dialog.close();
  });
  panel.addEventListener("transitionend", event => {
    if (event.target === panel && event.propertyName === "transform") finishMermaidLightboxClose(lightbox);
  });
  document.body.append(dialog);
  return lightbox;
}

function closeMermaidLightbox(lightbox, restoreFocus = true) {
  if (!lightbox.dialog.open || lightbox.closeTimer !== undefined) return;
  clearMermaidCloseTimer(lightbox);
  lightbox.restoreFocus = restoreFocus;
  const wasVisible = lightbox.dialog.classList.contains("is-visible");
  lightbox.dialog.classList.remove("is-visible");
  if (!wasVisible || prefersReducedMotion()) {
    lightbox.dialog.close();
    return;
  }
  lightbox.closeTimer = window.setTimeout(
    () => finishMermaidLightboxClose(lightbox),
    MERMAID_DIALOG_CLOSE_FALLBACK_MS,
  );
}

function finishMermaidLightboxClose(lightbox) {
  if (lightbox.closeTimer === undefined) return;
  clearMermaidCloseTimer(lightbox);
  if (lightbox.dialog.open) lightbox.dialog.close();
}

function clearMermaidCloseTimer(lightbox) {
  if (lightbox.closeTimer !== undefined) clearTimeout(lightbox.closeTimer);
  lightbox.closeTimer = undefined;
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function restoreMermaidDiagram(lightbox, restoreFocus = true) {
  const active = lightbox.active;
  if (!active) return;
  lightbox.viewport.replaceChildren();
  lightbox.viewport.style.removeProperty("--mermaid-zoom-width");
  lightbox.active = undefined;
  document.documentElement.classList.remove("has-mermaid-dialog");
  if (restoreFocus) active.opener.focus({ preventScroll: true });
}

function startVisualLoading(pre, kind, widthClass) {
  const loader = document.createElement("div");
  loader.className = "visual-loader " + widthClass;
  loader.setAttribute("role", "status");
  loader.setAttribute("aria-label", loadingLabel(kind));
  const indicator = document.createElement("span");
  indicator.className = "loading-indicator";
  indicator.setAttribute("aria-hidden", "true");
  loader.append(indicator);
  pre.before(loader);
  pre.hidden = true;
  return loader;
}

function evidenceContext(pre) {
  const before = pre.previousElementSibling;
  const after = pre.nextElementSibling;
  return {
    caption: before?.tagName === "P" && startsWithStrong(before) && !isEvidenceNote(before) ? before : undefined,
    note: after?.tagName === "P" && isEvidenceNote(after) ? after : undefined,
  };
}

function startsWithStrong(paragraph) {
  const first = [...paragraph.childNodes].find(node => node.nodeType !== Node.TEXT_NODE || node.textContent.trim() !== "");
  return first?.nodeType === Node.ELEMENT_NODE && first.tagName === "STRONG";
}

function isEvidenceNote(paragraph) {
  const label = paragraph.querySelector(":scope > strong:first-child")?.textContent?.trim() || "";
  return /^(?:sources?|notes?|methods?|来源|资料来源|注|注释|方法|口径|出典|출처|참고)/iu.test(label);
}

function appendEvidenceCaption(figure, context) {
  if (!context.caption) return;
  const caption = document.createElement("figcaption");
  caption.className = "evidence-caption";
  caption.append(...context.caption.childNodes);
  context.caption.remove();
  figure.insertBefore(caption, figure.firstChild);
}

function appendEvidenceNote(figure, context) {
  if (!context.note) return;
  context.note.classList.add("evidence-note");
  figure.append(context.note);
}

function evidenceLabel(context) {
  return context.caption?.textContent?.trim() || "";
}

function mermaidWidthClass(svg) {
  const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/[ ,]+/u).map(Number);
  if (viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value))) return "width-medium";
  const [, , width, height] = viewBox;
  return width > 900 || width / Math.max(height, 1) > 2.4 ? "width-evidence" : "width-medium";
}

function revealVisualSource(candidate) {
  candidate.loader.remove();
  candidate.pre.hidden = false;
}

function sanitizeSvg(svg) {
  for (const element of svg.querySelectorAll("script, foreignObject, iframe, object, embed, image, a")) element.remove();
  for (const style of svg.querySelectorAll("style")) {
    style.textContent = (style.textContent || "").replace(/@import\s+url\((?:'[^']*'|"[^"]*"|[^)]*)\)\s*;/giu, "");
  }
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "href" || name === "xlink:href") element.removeAttribute(attribute.name);
    }
  }
}

async function renderEChartsBlocks() {
  const candidates = [];
  for (const block of article.querySelectorAll("pre > code.language-echarts")) {
    try {
      const option = JSON.parse(block.textContent || "");
      if (!isRecord(option)) throw new Error("ECharts option must be an object.");
      normalizeEChartsOption(option);
      const pre = block.parentElement;
      if (!pre) continue;
      const table = dataTableFor(option);
      const widthClass = chartWidthClass(option, table);
      candidates.push({
        block,
        pre,
        option,
        table,
        widthClass,
        context: evidenceContext(pre),
        loader: startVisualLoading(pre, "chart", widthClass),
      });
    } catch (error) {
      console.warn("An ECharts option is invalid; preserving its source.", error);
    }
  }
  if (candidates.length === 0) return;

  let echarts;
  try {
    const module = await withTimeout(import(ECHARTS_URL), VISUAL_TIMEOUT_MS, "ECharts timed out.");
    echarts = typeof module.init === "function" ? module : module.default;
    if (!echarts || typeof echarts.init !== "function") throw new Error("ECharts init is unavailable.");
  } catch (error) {
    for (const candidate of candidates) replaceWithDataFallback(candidate);
    console.warn("ECharts could not be loaded; using data tables where available and preserving other chart sources.", error);
    return;
  }

  const ink = resolvedColor("--color-ink");
  const muted = resolvedColor("--color-muted");
  const line = resolvedColor("--color-line");
  const paper = resolvedColor("--color-paper");
  const chartTheme = {
    color: Array.from({ length: 7 }, (_, index) => resolvedColor("--color-chart-" + (index + 1))),
    textStyle: { color: ink, fontFamily: cssValue("--font-body"), fontSize: 13 },
    title: { textStyle: { color: ink } },
    legend: { textStyle: { color: muted, fontSize: 13 } },
    tooltip: { backgroundColor: paper, borderColor: line, textStyle: { color: ink } },
    categoryAxis: {
      axisLine: { lineStyle: { color: line } },
      axisTick: { lineStyle: { color: line } },
      axisLabel: { color: muted, fontSize: 13 },
      splitLine: { lineStyle: { color: line } },
    },
    valueAxis: {
      axisLine: { lineStyle: { color: line } },
      axisTick: { lineStyle: { color: line } },
      axisLabel: { color: muted, fontSize: 13 },
      splitLine: { lineStyle: { color: line } },
    },
  };

  for (const candidate of candidates) {
    const figure = document.createElement("figure");
    figure.className = "evidence-figure echarts-figure " + candidate.widthClass;
    const accessibleTitle = optionTitle(candidate.option) || evidenceLabel(candidate.context) || nearbyHeading(candidate.pre) || "Chart";
    const mount = document.createElement("div");
    mount.className = "echarts-mount";
    mount.style.height = chartHeight(candidate.option) + "px";
    mount.setAttribute("role", "img");
    mount.setAttribute("aria-label", accessibleTitle);
    figure.append(mount);
    candidate.loader.replaceWith(figure);

    let chart;
    try {
      chart = echarts.init(mount, chartTheme, { renderer: "svg" });
      chart.setOption(candidate.option);
      const observer = new ResizeObserver(() => chart.resize());
      observer.observe(mount);
      appendEvidenceCaption(figure, candidate.context);
      appendEvidenceNote(figure, candidate.context);
      if (candidate.table) figure.append(dataDetails(candidate.table));
      candidate.pre.remove();
    } catch (error) {
      chart?.dispose?.();
      figure.remove();
      replaceWithDataFallback(candidate);
      console.warn("An ECharts figure could not be rendered; using its data table when available and otherwise preserving its source.", error);
    }
  }
}

function replaceWithDataFallback(candidate) {
  if (!candidate.table) {
    revealVisualSource(candidate);
    return;
  }
  const figure = document.createElement("figure");
  figure.className = "evidence-figure echarts-fallback " + candidate.widthClass;
  appendEvidenceCaption(figure, candidate.context);
  const details = dataDetails(candidate.table);
  details.open = true;
  figure.append(details);
  appendEvidenceNote(figure, candidate.context);
  if (candidate.loader.isConnected) candidate.loader.replaceWith(figure);
  else candidate.pre.before(figure);
  candidate.pre.remove();
}

function handleInteractiveMessage(event) {
  const message = event.data;
  if (!isRecord(message) || message.channel !== "acpus-interactive" || typeof message.id !== "string") return;
  const entry = interactiveFrames.get(message.id);
  if (!entry || event.source !== entry.iframe.contentWindow) return;

  if (message.type === "resize") {
    const height = Number(message.height);
    if (!Number.isFinite(height) || height <= 0) return;
    entry.iframe.style.height = Math.min(1600, Math.max(240, Math.ceil(height))) + "px";
    return;
  }
  if (message.type === "ready") entry.ready();
  else if (message.type === "error") entry.fail(message.message);
}

async function renderInteractiveBlocks() {
  const candidates = [...article.querySelectorAll("pre > code.language-interactive")].flatMap(block => {
    const pre = block.parentElement;
    return pre ? [{ block, pre, context: evidenceContext(pre), loader: startVisualLoading(pre, "interactive", "width-medium") }] : [];
  });
  if (candidates.length === 0) return;

  await Promise.all(candidates.map((candidate, index) => new Promise(resolve => {
    const id = "interactive-" + (index + 1);
    const figure = document.createElement("figure");
    figure.className = "evidence-figure interactive-figure width-medium";
    const stage = document.createElement("div");
    stage.className = "interactive-stage";
    const iframe = document.createElement("iframe");
    iframe.className = "interactive-frame";
    iframe.loading = "eager";
    iframe.title = evidenceLabel(candidate.context) || nearbyHeading(candidate.pre) || interactiveTitle();
    iframe.setAttribute("aria-hidden", "true");
    candidate.loader.classList.remove("width-medium", "width-evidence");
    candidate.loader.replaceWith(figure);
    stage.append(candidate.loader, iframe);
    figure.append(stage);

    const entry = {
      iframe,
      settled: false,
      timer: undefined,
      ready() {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        candidate.loader.remove();
        iframe.removeAttribute("aria-hidden");
        stage.classList.add("is-ready");
        appendEvidenceCaption(figure, candidate.context);
        appendEvidenceNote(figure, candidate.context);
        candidate.pre.remove();
        resolve();
      },
      fail(message) {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        interactiveFrames.delete(id);
        figure.remove();
        candidate.pre.hidden = false;
        console.warn("Interactive content could not be rendered; preserving its source.", message || "Unknown error.");
        resolve();
      },
    };
    interactiveFrames.set(id, entry);
    entry.timer = setTimeout(() => entry.fail("Interactive content timed out."), VISUAL_TIMEOUT_MS);

    try {
      iframe.srcdoc = interactiveDocument(candidate.block.textContent || "", id);
    } catch (error) {
      entry.fail(error instanceof Error ? error.message : String(error));
    }
  })));
}

function interactiveTitle() {
  const labels = {
    "zh-CN": "交互式说明",
    ja: "インタラクティブな説明",
    ko: "인터랙티브 설명",
    en: "Interactive explanation",
  };
  return labels[language] || labels.en;
}

function interactiveDocument(source, id) {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  if (!parsed.documentElement || !parsed.head || !parsed.body) throw new Error("Interactive HTML could not be parsed.");
  parsed.documentElement.lang = language;
  parsed.documentElement.dir = document.documentElement.dir || "ltr";

  const theme = parsed.createElement("style");
  theme.setAttribute("data-acpus-theme", "");
  theme.textContent = interactiveThemeCss();

  const bridge = parsed.createElement("script");
  bridge.setAttribute("data-acpus-bridge", "");
  bridge.textContent = [
    "(() => {",
    "  const channel = 'acpus-interactive';",
    "  const id = '" + id + "';",
    "  const send = (type, detail = {}) => parent.postMessage({ channel, id, type, ...detail }, '*');",
    "  let failed = false;",
    "  addEventListener('error', event => {",
    "    if (event.target !== window) return;",
    "    failed = true;",
    "    send('error', { message: event.message || 'Interactive content failed.' });",
    "  });",
    "  addEventListener('unhandledrejection', event => {",
    "    failed = true;",
    "    send('error', { message: String(event.reason || 'Interactive content failed.') });",
    "  });",
    "  const start = () => {",
    "    const report = () => send('resize', { height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) });",
    "    if ('ResizeObserver' in window) new ResizeObserver(report).observe(document.documentElement);",
    "    document.fonts?.ready.then(report);",
    "    report();",
    "    requestAnimationFrame(() => { report(); if (!failed) send('ready'); });",
    "  };",
    "  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });",
    "  else start();",
    "})();",
  ].join("\n");

  parsed.head.prepend(theme);
  parsed.head.prepend(bridge);
  return "<!doctype html>\n" + parsed.documentElement.outerHTML;
}

function interactiveThemeCss() {
  const tokens = [
    "--space-2xs", "--space-xs", "--space-sm", "--space-md", "--space-lg", "--space-xl",
    "--text-sm", "--font-display", "--font-body", "--font-mono",
    "--color-page", "--color-paper", "--color-ink", "--color-ink-strong", "--color-muted",
    "--color-line", "--color-soft", "--color-accent", "--color-accent-soft", "--color-focus",
  ];
  const variables = tokens.map(name => name + ":" + cssValue(name)).join(";");
  return ":root{" + variables + ";color-scheme:light}" +
    "*{box-sizing:border-box}" +
    "html{background:transparent;color:var(--color-ink);font-family:var(--font-body);font-size:16px;line-height:1.6}" +
    "body{min-width:0;margin:0;padding:var(--space-md);background:transparent;color:inherit;font:inherit}" +
    "button,input,select,textarea{font:inherit}" +
    "img,svg,canvas{max-width:100%}" +
    "a{color:var(--color-accent);text-underline-offset:.18em}" +
    ":focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}";
}

function normalizeEChartsOption(option) {
  option.animation = false;
  option.backgroundColor = "transparent";
  option.aria = { ...(isRecord(option.aria) ? option.aria : {}), enabled: true };
  normalizeUnsafeTree(option, []);
  normalizeEChartsHeader(option);

  for (const tooltip of asArray(option.tooltip)) {
    if (!isRecord(tooltip)) continue;
    tooltip.renderMode = "richText";
    delete tooltip.extraCssText;
  }

  for (const toolbox of asArray(option.toolbox)) {
    if (!isRecord(toolbox) || !isRecord(toolbox.feature)) continue;
    delete toolbox.feature.dataView;
    if (isRecord(toolbox.feature.saveAsImage)) {
      toolbox.feature.saveAsImage.name = "chart";
      toolbox.feature.saveAsImage.type = "png";
    }
  }
}

function normalizeEChartsHeader(option) {
  const titles = asArray(option.title).filter(isRecord);
  const legends = asArray(option.legend).filter(isRecord);
  const grids = asArray(option.grid).filter(isRecord);
  if (titles.length !== 1 || legends.length > 1 || grids.length > 1) return;

  const title = titles[0];
  const titleTop = title.top;
  if (title.show === false || typeof title.text !== "string" || !title.text.trim()
    || title.bottom !== undefined
    || !(titleTop === undefined || (typeof titleTop === "number" && titleTop <= 24))) return;

  const titleClearance = Math.max(64, (typeof titleTop === "number" ? titleTop : 0) + 64)
    + (typeof title.subtext === "string" && title.subtext.trim() ? 24 : 0);
  let contentTop = titleClearance + 8;
  const legend = legends[0];
  if (legend && legend.show !== false && legend.bottom === undefined
    && (legend.top === undefined || typeof legend.top === "number")) {
    legend.top = Math.max(typeof legend.top === "number" ? legend.top : 0, titleClearance);
    contentTop = legend.top + 36;
  }

  const hasCartesianAxes = option.xAxis !== undefined || option.yAxis !== undefined;
  if (!hasCartesianAxes) return;
  if (grids.length === 0) {
    option.grid = { top: contentTop };
    return;
  }
  const grid = grids[0];
  if (grid.top === undefined || typeof grid.top === "number") {
    grid.top = Math.max(typeof grid.top === "number" ? grid.top : 0, contentTop);
  }
}

function normalizeUnsafeTree(value, path) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) normalizeUnsafeTree(value[index], path.concat(String(index)));
    return;
  }
  if (!isRecord(value)) return;

  if (path.at(-1) === "tooltip") {
    value.renderMode = "richText";
    delete value.extraCssText;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "reg" && path.includes("transform")) {
      delete value[key];
      continue;
    }
    if (key === "link" || key === "sublink") {
      const safe = safeLink(child);
      if (safe === undefined) delete value[key];
      else value[key] = safe;
      continue;
    }
    const symbolImage = key === "symbol" && typeof child === "string"
      && /^(?:image:\/\/|https?:\/\/|data:)/iu.test(child);
    if (key === "image" || symbolImage) {
      const safe = safeImage(child);
      if (safe === undefined) delete value[key];
      else value[key] = safe;
      continue;
    }
    normalizeUnsafeTree(child, path.concat(key));
  }
}

function safeLink(value) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("#")) return value;
  try { return new URL(value).protocol === "https:" ? value : undefined; } catch { return undefined; }
}

function safeImage(value) {
  if (typeof value !== "string") return undefined;
  const prefix = value.startsWith("image://") ? "image://" : "";
  const source = prefix ? value.slice(prefix.length) : value;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,/iu.test(source)) return value;
  try { return new URL(source).protocol === "https:" ? prefix + source : undefined; } catch { return undefined; }
}

function dataTableFor(option) {
  const dataset = asArray(option.dataset).find(item => isRecord(item) && Array.isArray(item.source));
  if (dataset) {
    const source = dataset.source;
    if (source.length > 0 && source.every(row => Array.isArray(row))) {
      const dimensions = dimensionNames(dataset.dimensions);
      const sourceHeader = dataset.sourceHeader === true
        || (dataset.sourceHeader === undefined && dimensions.length === 0);
      const headers = dimensions.length > 0
        ? dimensions
        : sourceHeader
          ? source[0].map(String)
          : source[0].map((_, index) => "Dimension " + (index + 1));
      return { headers, rows: (sourceHeader ? source.slice(1) : source).map(row => row.map(displayValue)) };
    }
    if (source.length > 0 && source.every(isRecord)) {
      const headers = dimensionNames(dataset.dimensions);
      const keys = headers.length > 0 ? headers : Object.keys(source[0]);
      return { headers: keys, rows: source.map(row => keys.map(key => displayValue(row[key]))) };
    }
  }

  const gaugeRows = [];
  for (const series of asArray(option.series)) {
    if (!isRecord(series) || series.type !== "gauge") continue;
    for (const item of asArray(series.data)) {
      if (isRecord(item)) gaugeRows.push([displayValue(item.name || series.name || "Value"), displayValue(item.value)]);
    }
  }
  return gaugeRows.length > 0 ? { headers: ["Name", "Value"], rows: gaugeRows } : undefined;
}

function dimensionNames(dimensions) {
  return asArray(dimensions).flatMap(item => typeof item === "string" ? [item] : isRecord(item) && typeof item.name === "string" ? [item.name] : []);
}

function dataDetails(data) {
  const details = document.createElement("details");
  details.className = "chart-data";
  const summary = document.createElement("summary");
  summary.textContent = language === "zh-CN" ? "数据表" : language === "ja" ? "データ表" : language === "ko" ? "데이터 표" : "Data table";
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  prepareTableRegion(wrap);
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of data.headers) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of data.rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      cell.textContent = value;
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  details.append(summary, wrap);
  return details;
}

function prepareTableRegion(wrap) {
  const labels = {
    "zh-CN": "可横向滚动的数据表",
    ja: "横スクロール可能なデータ表",
    ko: "가로로 스크롤할 수 있는 데이터 표",
    en: "Scrollable data table",
  };
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", labels[language] || labels.en);
}

function tableWidthClass(table) {
  const rows = [...table.rows];
  const columns = Math.max(0, ...rows.map(row => [...row.cells]
    .reduce((count, cell) => count + cell.colSpan, 0)));
  if (columns >= 5) return "width-evidence";
  if (columns >= 3) return "width-medium";
  return "";
}

function chartHeight(option) {
  const horizontal = asArray(option.yAxis).some(axis => isRecord(axis) && axis.type === "category");
  if (horizontal) {
    const dataset = asArray(option.dataset).find(item => isRecord(item) && Array.isArray(item.source));
    const hasHeader = dataset && (dataset.sourceHeader === true
      || (dataset.sourceHeader === undefined && dimensionNames(dataset.dimensions).length === 0));
    const count = dataset ? Math.max(1, dataset.source.length - (hasHeader ? 1 : 0)) : 8;
    return Math.min(720, Math.max(340, count * 36 + 120));
  }
  return asArray(option.series).some(series => isRecord(series) && series.type === "gauge") ? 360 : 440;
}

function chartWidthClass(option, table) {
  const seriesCount = asArray(option.series).filter(isRecord).length;
  const panelCount = Math.max(asArray(option.grid).length, asArray(option.xAxis).length, asArray(option.yAxis).length);
  const denseTable = table && (table.headers.length > 3 || table.rows.length > 12);
  return seriesCount > 1 || panelCount > 1 || denseTable ? "width-evidence" : "width-medium";
}

function optionTitle(option) {
  const title = asArray(option.title).find(isRecord);
  return title && typeof title.text === "string" ? title.text : "";
}

function nearbyHeading(element) {
  let current = element.previousElementSibling;
  while (current) {
    if (/^H[1-4]$/u.test(current.tagName)) return current.textContent?.trim() || "";
    current = current.previousElementSibling;
  }
  return article.querySelector("h1")?.textContent?.trim() || "";
}

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resolvedColor(name) {
  const probe = document.createElement("span");
  probe.style.color = "var(" + name + ")";
  probe.hidden = true;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  if (!colorContext) return color;
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = color;
  colorContext.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
  if (alpha === 255) return "rgb(" + red + "," + green + "," + blue + ")";
  return "rgba(" + red + "," + green + "," + blue + "," + Math.round(alpha / 255 * 1000) / 1000 + ")";
}

function asArray(value) { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function displayValue(value) { return value === null || value === undefined ? "" : typeof value === "object" ? String(value.value ?? "") : String(value); }
`;

/** Renders a deterministic HTML shell; all rich rendering happens in the browser. */
export const renderPublicationDelivery = task.define({
  inputSchema: RenderPublicationInput,
  exec: async ({ input }): Promise<RenderedPublication> => {
    if (!input.completed) throw new Error("Rendering cannot run before the Lead report is complete.");
    const { readFile, writeFile } = await import("node:fs/promises");
    const markdown = await readFile(input.editorialPath, "utf8");
    await writeFile(input.htmlPath, await renderPublicationHtml(markdown), "utf8");
    return { htmlPath: input.htmlPath };
  },
});

function renderPublicationHtml(markdown: string): string {
  return documentHtml(markdown);
}

function documentHtml(markdown: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; font-src https: data:; img-src https: data: blob:; connect-src https:; media-src https: data: blob:; worker-src https: blob:; base-uri 'none'; form-action 'none'; frame-src 'self' https:; object-src 'none'">
  <title>Research report</title>
  <style>${PUBLICATION_STYLE}</style>
</head>
<body class="is-loading"><!--
  DIRECTION CONTRACT
  THESIS: One deterministic editorial renderer keeps attention on the research instead of theme selection.
  OWN-WORLD: Near-white cool paper, system-sans reading, system-serif headlines, JetBrains Mono evidence, restrained carmine, and only structural rulework; no paper texture, decorative lines, black gridwork, generic cards, or renderer-authored claims.
  STORY: Orient the reader, expose the governing relationship, then make evidence easy to inspect.
  FIRST VIEWPORT: Title, short thesis, and the first useful structural cue—not a decorative hero.
  FORM: A continuous single-column long document with a wrapping contents rail, aligned prose and callouts, and wider evidence surfaces.
  FINISH: Static print rhythm after the functional loader, exact alignment, legible evidence, and citations that behave as navigation.
-->
  <noscript><style>body.is-loading .publication-source{display:block}.publication-loader{display:none}</style></noscript>
  <div class="page-shell">
    <nav id="article-nav" class="article-nav" aria-label="Article sections" hidden></nav>
    <main>
      <div id="publication-loader" class="publication-loader" role="status" aria-label="Formatting report">
        <span class="loading-indicator" aria-hidden="true"></span>
      </div>
      <article id="publication" class="publication">
        <pre id="publication-source" class="publication-source">${escapeHtml(markdown)}</pre>
      </article>
    </main>
  </div>
  <script type="module">${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
