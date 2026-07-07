import { afterAll, describe, expect, it } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { mountStaticAssets } from "../src/server/assets.js";

const staticDir = join(tmpdir(), "acpus-web-test-assets-" + Date.now());
const assetsDir = join(staticDir, "assets");

async function setupFixture(files: Record<string, string>) {
  await mkdir(assetsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(assetsDir, name), content);
  }
}

async function setupRoot(files: Record<string, string>) {
  await mkdir(staticDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(staticDir, name), content);
  }
}

describe("mountStaticAssets", () => {
  afterAll(async () => {
    await rm(staticDir, { recursive: true, force: true });
  });

  it("serves index.html at root", async () => {
    await setupRoot({ "index.html": "<html></html>" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html></html>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves CSS with correct content-type", async () => {
    await setupFixture({ "styles.css": "body { color: red; }" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/assets/styles.css");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body { color: red; }");
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("serves JS with correct content-type", async () => {
    await setupFixture({ "app.js": "console.log(1)" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("serves JSON with correct content-type", async () => {
    await setupFixture({ "data.json": "{}" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/assets/data.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("serves SVG with correct content-type", async () => {
    await setupFixture({ "icon.svg": "<svg></svg>" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/assets/icon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("serves favicon.ico", async () => {
    await setupRoot({ "favicon.ico": "fav" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fav");
  });

  it("returns 404 for missing file", async () => {
    await mkdir(staticDir, { recursive: true });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/assets/missing.js");
    expect(res.status).toBe(404);
  });

  it("returns 404 when staticDir is not provided", async () => {
    const app = new Hono();
    mountStaticAssets(app, undefined);
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });

  it("api routes are not shadowed by catch-all", async () => {
    await setupRoot({ "index.html": "ok" });
    const app = new Hono();
    app.get("/api/health", (c) => c.json({ ok: true }));
    mountStaticAssets(app, staticDir);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves index.html for SPA fallback on unknown route", async () => {
    await setupRoot({ "index.html": "<html></html>" });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/some/spa/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html></html>");
  });

  it("returns 404 for directory paths", async () => {
    await setupRoot({ "index.html": "ok" });
    await mkdir(join(staticDir, "assets", "sub"), { recursive: true });
    const app = new Hono();
    mountStaticAssets(app, staticDir);
    const res = await app.request("/assets/sub");
    expect(res.status).toBe(404);
  });
});