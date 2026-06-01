import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunReportView } from "../projections/run-report.js";

export async function renderHtmlReport(view: RunReportView): Promise<string> {
  return renderReportAppHtml({ snapshot: view });
}

export async function renderLiveReportShell(options: { runId: string }): Promise<string> {
  return renderReportAppHtml({ live: { runId: options.runId } });
}

export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export async function inlineReportAssets(indexHtml: string, webRoot: string): Promise<string> {
  const withStyles = await inlineStyles(indexHtml, webRoot);
  return inlineScripts(withStyles, webRoot);
}

export function injectReportPayload(html: string, options: { snapshot?: RunReportView; live?: { runId: string } }): string {
  const payload = options.snapshot
    ? `<script id="acpx-report-snapshot" type="application/json">${escapeJsonForHtml(options.snapshot)}</script>`
    : `<script id="acpx-report-live" type="application/json">${escapeJsonForHtml(options.live ?? {})}</script>`;
  return html.replace("</body>", `${payload}\n</body>`);
}

async function renderReportAppHtml(options: { snapshot?: RunReportView; live?: { runId: string } }): Promise<string> {
  const root = await findPackageRoot();
  const webRoot = path.join(root, "dist", "report-web");
  const indexPath = path.join(webRoot, "index.html");
  let html: string;
  try {
    html = await fs.readFile(indexPath, "utf8");
  } catch {
    throw new Error(`HTML report frontend is not built. Run npm run build in ${root}.`);
  }
  return injectReportPayload(await inlineReportAssets(html, webRoot), options);
}

async function inlineStyles(html: string, webRoot: string): Promise<string> {
  const stylesheetPattern = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g;
  return replaceAsync(html, stylesheetPattern, async (match, href: string) => {
    const asset = await readAsset(webRoot, href);
    return `<style data-inlined-from="${escapeAttribute(href)}">\n${asset}\n</style>`;
  });
}

async function inlineScripts(html: string, webRoot: string): Promise<string> {
  const scriptPattern = /<script\s+([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/g;
  return replaceAsync(html, scriptPattern, async (_match, before: string, src: string, after: string) => {
    const asset = await readAsset(webRoot, src);
    const attrs = `${before} ${after}`.replace(/\s+/g, " ").trim();
    return `<script ${attrs} data-inlined-from="${escapeAttribute(src)}">\n${asset}\n</script>`;
  });
}

async function readAsset(webRoot: string, href: string): Promise<string> {
  const normalized = href.replace(/^\//, "");
  const resolved = path.resolve(webRoot, normalized);
  if (!resolved.startsWith(path.resolve(webRoot))) {
    throw new Error(`Refusing to inline asset outside report web root: ${href}`);
  }
  return fs.readFile(resolved, "utf8");
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: string, ...captures: string[]) => Promise<string>
): Promise<string> {
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of input.matchAll(pattern)) {
    parts.push(input.slice(lastIndex, match.index));
    parts.push(await replacer(match[0], ...match.slice(1)));
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  parts.push(input.slice(lastIndex));
  return parts.join("");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function findPackageRoot(): Promise<string> {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    path.resolve(path.dirname(process.argv[1] ?? "."), ".."),
    process.cwd()
  ];
  for (const candidate of candidates) {
    const found = await ascendToPackageRoot(candidate);
    if (found) return found;
  }
  return process.cwd();
}

async function ascendToPackageRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "@kelvinschen/acpx-workflow-orchestrator") return current;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
