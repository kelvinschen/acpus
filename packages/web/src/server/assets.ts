import { readFile, stat } from "node:fs/promises";
import { extname, normalize, relative, resolve } from "node:path";
import type { Hono } from "hono";

export function mountStaticAssets(app: Hono, staticDir: string): void {
  app.get("/assets/*", context => serveAsset(context, staticDir, context.req.path.slice(1)));
  app.get("/favicon.ico", context => serveAsset(context, staticDir, "favicon.ico"));
  app.get("*", context => {
    if (context.req.path.startsWith("/api/")) return context.notFound();
    return serveAsset(context, staticDir, "index.html");
  });
}

async function serveAsset(context: any, staticDir: string, requestPath: string): Promise<Response> {
  const file = containedPath(staticDir, requestPath);
  if (!file) return context.notFound();
  try {
    const info = await stat(file);
    if (!info.isFile()) return context.notFound();
    return new Response(await readFile(file), { headers: { "content-type": contentType(file) } });
  } catch {
    return context.notFound();
  }
}

function containedPath(root: string, requestPath: string): string | undefined {
  const target = resolve(root, normalize(requestPath));
  const fromRoot = relative(resolve(root), target);
  if (fromRoot.startsWith("..") || (resolve(root) === target && requestPath !== "index.html"))
    return undefined;
  return target;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}
