#!/usr/bin/env node
// viz-server.mjs — Live visualization service for the swarm-intelligence workflow.
//
// Usage:
//   node viz-server.mjs <blackboard_dir> [port]              # serve a run dir
//   node viz-server.mjs start <enabled> <blackboard_dir> [port]
//   node viz-server.mjs stop <blackboard_dir>
//   node viz-server.mjs export <blackboard_dir> <output_html>
//   node viz-server.mjs --server <blackboard_dir> <port>     # internal
//
// The script forks itself with --server and returns immediately so the workflow
// step does not block. The detached server watches the blackboard directory,
// exposes /api/snapshot for the full state, and /api/stream (SSE) for live
// updates, and serves the colocated frontend at /.

import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect } from "node:net";
import { existsSync, mkdirSync, rmSync, watch } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VIZ_DIR = __dirname;
const INFO_FILE = "viz-server.json";
const LOCK_DIR = "viz-server.lock";
const SERVER_TTL_MS = 3 * 60 * 60 * 1000;

const ROLES = ["challenger", "builder", "synthesizer", "empiricist"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function snapshot(bbDir) {
  const blackboardPath = join(bbDir, "blackboard.json");
  const blackboard = await readJson(blackboardPath);
  const mtimes = { blackboard: await mtime(blackboardPath), rounds: {} };
  const rounds = {};
  const attention = {};
  for (const role of ROLES) {
    const roundPath = join(bbDir, `${role}-round.json`);
    rounds[role] = await readJson(roundPath);
    mtimes.rounds[role] = await mtime(roundPath);
    attention[role] = await readJson(join(bbDir, `attention-${role}.json`));
  }
  const summaryPath = join(bbDir, "summary.md");
  const summary = existsSync(summaryPath) ? await readFile(summaryPath, "utf-8") : null;
  return { blackboard, rounds, attention, summary, dir: bbDir, ts: Date.now(), mtimes };
}

function runServer(bbDir, port) {
  const clients = new Set();
  const sockets = new Set();
  const broadcast = () => {
    const payload = `event: change\ndata: ${Date.now()}\n\n`;
    for (const c of clients) c.write(payload);
  };

  let timer;
  const scheduleBroadcast = () => {
    clearTimeout(timer);
    timer = setTimeout(broadcast, 150);
  };
  if (existsSync(bbDir)) {
    watch(bbDir, { persistent: true }, scheduleBroadcast);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/api/snapshot") {
        const body = JSON.stringify(await snapshot(bbDir));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (url.pathname === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const file = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = join(VIZ_DIR, file);
      if (!filePath.startsWith(VIZ_DIR + "/") && filePath !== join(VIZ_DIR, "index.html")) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        "content-type": MIME[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });

  server.listen(port, "0.0.0.0");
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  setTimeout(() => {
    for (const c of clients) c.end();
    server.close(() => process.exit(0));
    for (const socket of sockets) socket.destroy();
  }, SERVER_TTL_MS).unref();
}

function findFreePort() {
  return new Promise((res) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function waitPort(port, timeoutMs = 5000) {
  return new Promise((res) => {
    const start = Date.now();
    const tryConn = () => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => { s.end(); res(true); });
      s.once("error", () => {
        if (Date.now() - start > timeoutMs) res(false);
        else setTimeout(tryConn, 100);
      });
    };
    tryConn();
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function serverReady(info) {
  if (!info?.pid || !info?.port || !pidAlive(info.pid)) return false;
  return waitPort(Number(info.port), 500);
}

async function readLiveServer(infoPath) {
  const info = await readJson(infoPath);
  return await serverReady(info) ? { ...info, ready: true } : null;
}

async function withStartLock(bbDir, fn) {
  const lockDir = join(bbDir, LOCK_DIR);
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started > 5000) rmSync(lockDir, { recursive: true, force: true });
      else await sleep(100);
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function startServer(bbDirArg, portArg) {
  const bbDir = resolve(bbDirArg || ".");
  if (!existsSync(bbDir)) mkdirSync(bbDir, { recursive: true });
  const infoPath = join(bbDir, INFO_FILE);

  return withStartLock(bbDir, async () => {
    const existing = await readLiveServer(infoPath);
    if (existing) return existing;

    const port = portArg ? Number(portArg) : await findFreePort();
    const logFile = join(bbDir, "viz-server.log");
    const fs = await import("node:fs");
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [__filename, "--server", bbDir, String(port)], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();

    const ready = await waitPort(port);
    const url = `http://localhost:${port}/`;
    const startedAt = Date.now();
    const info = {
      enabled: true,
      url,
      port,
      pid: child.pid,
      blackboard_dir: bbDir,
      log: logFile,
      ready,
      ttl_ms: SERVER_TTL_MS,
      started_at: new Date(startedAt).toISOString(),
      expires_at: new Date(startedAt + SERVER_TTL_MS).toISOString(),
    };
    await writeFile(infoPath, JSON.stringify(info, null, 2));
    return info;
  });
}

async function stopServer(bbDirArg) {
  const bbDir = resolve(bbDirArg || ".");
  const infoPath = join(bbDir, INFO_FILE);
  const info = await readJson(infoPath);
  if (!info?.pid) {
    return { enabled: false, stopped: false, reason: "no_server", url: "", port: 0, pid: 0 };
  }

  try {
    process.kill(Number(info.pid), "SIGTERM");
    return { ...info, stopped: true };
  } catch (error) {
    return { ...info, stopped: false, reason: error.code || error.message };
  }
}

function inlineScriptJson(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const HELP_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

async function exportHtml(bbDirArg, outputArg) {
  const bbDir = resolve(bbDirArg || ".");
  const outPath = resolve(outputArg || join(bbDir, "swarm-visualization.html"));
  const snap = await snapshot(bbDir);
  if (!snap.blackboard) throw new Error(`No blackboard.json found in ${bbDir}`);

  const [html, css, app] = await Promise.all([
    readFile(join(VIZ_DIR, "index.html"), "utf-8"),
    readFile(join(VIZ_DIR, "styles.css"), "utf-8"),
    readFile(join(VIZ_DIR, "app.js"), "utf-8"),
  ]);
  let markdownitInline = "";
  try {
    const { default: fetch } = await import("node:https");
    markdownitInline = await new Promise((res, rej) => {
      fetch.get("https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js", (r) => {
        let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(d)); r.on("error", rej);
      }).on("error", rej);
    });
  } catch { markdownitInline = ""; }

  const bundled = html
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com" \/>\n    /, "")
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin \/>\n    /, "")
    .replace(/<link href="https:\/\/fonts\.googleapis\.com[^"]+" rel="stylesheet" \/>\n    /, "")
    .replace(/<link rel="stylesheet" href="\.\/styles\.css" \/>/, () => `<style>\n${css}\n</style>`)
    .replace(/<script src="https:\/\/unpkg\.com\/lucide@latest\/dist\/umd\/lucide\.min\.js"><\/script>\n    /, "")
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/markdown-it@14\/dist\/markdown-it\.min\.js"><\/script>/,
      () => markdownitInline ? `<script>\n${markdownitInline}\n    </script>` : "")
    .replace(/<i data-lucide="circle-question-mark"><\/i>/, HELP_ICON_SVG)
    .replace(
      /<script type="module" src="\.\/app\.js"><\/script>/,
      () => `<script>window.SWARM_SNAPSHOT = ${inlineScriptJson(snap)};</script>\n    <script type="module">\n${app}\n    </script>`
    );

  await writeFile(outPath, bundled, "utf-8");
  return {
    output_html: outPath,
    blackboard_dir: bbDir,
    snapshot_ts: snap.ts,
    summary_included: Boolean(snap.summary),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--server") {
    runServer(resolve(args[1]), Number(args[2]));
    return;
  }

  if (args[0] === "start") {
    if (args[1] !== "true") {
      console.log(JSON.stringify({
        enabled: false,
        url: "",
        port: 0,
        pid: 0,
        blackboard_dir: resolve(args[2] || "."),
        log: "",
        ready: false,
        ttl_ms: 0,
        started_at: "",
        expires_at: "",
      }));
      return;
    }
    console.log(JSON.stringify(await startServer(args[2], args[3])));
    return;
  }

  if (args[0] === "stop") {
    console.log(JSON.stringify(await stopServer(args[1])));
    return;
  }

  if (args[0] === "export") {
    console.log(JSON.stringify(await exportHtml(args[1], args[2])));
    return;
  }

  console.log(JSON.stringify(await startServer(args[0], args[1])));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
