import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn, type IPty } from "node-pty";

export interface ServeTuiOptions {
  endpoint: string;
  runId?: string;
  listen?: string | boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

export interface ParsedListen {
  host: string;
  port: number;
}

interface SpawnPtyOptions {
  cols: number;
  rows: number;
}

type SpawnPty = (options: SpawnPtyOptions) => Pick<IPty, "onData" | "onExit" | "write" | "resize" | "kill">;

export interface ServedVisualizerBridgeOptions extends ServeTuiOptions {
  spawnPty?: SpawnPty;
  maxClients?: number;
}

const DEFAULT_LISTEN: ParsedListen = { host: "127.0.0.1", port: 0 };
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_MAX_CLIENTS = 8;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const WEBSOCKET_MAX_PAYLOAD_BYTES = 1024 * 1024;
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
  "x-content-type-options": "nosniff"
} as const;

interface WTermAssets {
  domDistDir: string;
  domCssPath: string;
  coreDistDir: string;
  coreWasmPath: string;
}

export async function serveTui(options: ServeTuiOptions): Promise<void> {
  const bridge = await startServedVisualizerBridge(options);
  const url = servedVisualizerUrl(bridge.host, bridge.port, bridge.token);
  const stdout = options.stdout ?? process.stdout;
  stdout.write(`Served visualizer: ${url}\n`);
  stdout.write("Press Ctrl-C to stop the served visualizer. Runs continue in the Run Supervisor.\n");
  await bridge.closed;
}

export async function startServedVisualizerBridge(options: ServedVisualizerBridgeOptions) {
  const listen = parseListen(options.listen);
  const assets = resolveWTermAssets();
  const token = createBridgeToken();
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const clients = new Set<ReturnType<SpawnPty>>();
  const sockets = new Set<WebSocket>();
  const spawnPty = options.spawnPty ?? ((ptyOptions) => spawnServedTuiPty(options, ptyOptions));
  const server = createServer((req, res) => {
    void handleHttpRequest(req, res, assets, token);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname !== "/ws" || !isAuthorizedBridgeRequest(req, url, token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  wss.on("connection", (ws) => {
    sockets.add(ws);
    if (clients.size >= maxClients) {
      sendJson(ws, { type: "error", message: "served visualizer client limit reached" });
      sockets.delete(ws);
      ws.close(1013, "client limit reached");
      return;
    }
    let pty: ReturnType<SpawnPty>;
    try {
      pty = spawnPty({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    } catch (error) {
      sockets.delete(ws);
      sendJson(ws, { type: "error", message: `Failed to start visualizer PTY: ${errorMessage(error)}` });
      ws.close();
      return;
    }
    clients.add(pty);
    let ptyExited = false;

    const disposePty = () => {
      sockets.delete(ws);
      clients.delete(pty);
      if (ptyExited) return;
      try {
        pty.kill();
      } catch {
        // The PTY may already be gone after an exit event.
      }
    };

    pty.onData((data) => {
      sendJson(ws, { type: "output", data });
    });
    pty.onExit(({ exitCode }) => {
      ptyExited = true;
      sendJson(ws, { type: "exit", exitCode });
      sockets.delete(ws);
      clients.delete(pty);
      ws.close();
    });
    ws.on("message", (raw) => {
      handleWebSocketMessage(raw, pty, ws);
    });
    ws.on("close", disposePty);
    ws.on("error", disposePty);
  });

  const closed = new Promise<void>((resolve) => {
    server.on("close", resolve);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listen.port, listen.host);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : listen.port;

  let closing = false;
  let signalHandler: (() => void) | undefined;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    for (const client of clients) {
      try {
        client.kill();
      } catch {
        // Ignore teardown races.
      }
    }
    clients.clear();
    for (const socket of sockets) {
      socket.terminate();
    }
    sockets.clear();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  };

  signalHandler = () => {
    void close().then(() => {
      process.exitCode = 0;
    });
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  return {
    host: listen.host,
    port: boundPort,
    token,
    closed,
    close,
    activeClientCount: () => clients.size
  };
}

export function parseListen(value: string | boolean | undefined): ParsedListen {
  if (value === undefined || value === true || value === "") return { ...DEFAULT_LISTEN };

  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    return { host: DEFAULT_LISTEN.host, port: parsePort(raw, raw) };
  }

  const match = /^([^:]+):(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid listen value '${raw}'. Use '--serve <port>' or put the run id before --serve.`);
  }
  const [, host, port] = match;
  return { host, port: parsePort(port, raw) };
}

function resolveWTermAssets(): WTermAssets {
  const require = createRequire(import.meta.url);
  const domDistDir = dirname(require.resolve("@wterm/dom"));
  const domPackageDir = dirname(domDistDir);
  return {
    domDistDir,
    domCssPath: require.resolve("@wterm/dom/css"),
    coreDistDir: dirname(require.resolve("@wterm/core", { paths: [domPackageDir] })),
    coreWasmPath: require.resolve("@wterm/core/wasm", { paths: [domPackageDir] })
  };
}

function parsePort(port: string, source: string): number {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid listen port in '${source}'. Port must be an integer from 0 to 65535.`);
  }
  return parsed;
}

function createBridgeToken(): string {
  return randomBytes(24).toString("base64url");
}

function servedVisualizerUrl(host: string, port: number, token: string): string {
  const url = new URL(`http://${host}:${port}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

function parseRequestUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

function isAuthorizedBridgeRequest(req: IncomingMessage, url: URL, token: string): boolean {
  if (url.searchParams.get("token") !== token) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const originUrl = new URL(origin);
    return (originUrl.protocol === "http:" || originUrl.protocol === "https:") && originUrl.host === host;
  } catch {
    return false;
  }
}

function spawnServedTuiPty(options: ServeTuiOptions, ptyOptions: SpawnPtyOptions): IPty {
  const entry = resolveServedEntry();
  const args = entry.kind === "source"
    ? ["--import", "tsx", entry.path]
    : [entry.path];
  return spawn(process.execPath, args, {
    name: "xterm-256color",
    cols: ptyOptions.cols,
    rows: ptyOptions.rows,
    cwd: process.cwd(),
    env: buildChildEnv(options)
  });
}

function resolveServedEntry(): { kind: "source" | "dist"; path: string } {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const source = join(dir, "served-entry.ts");
  if (existsSync(source)) return { kind: "source", path: source };
  return { kind: "dist", path: join(dir, "served-entry.js") };
}

function buildChildEnv(options: ServeTuiOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.ACPUS_TUI_ENDPOINT = options.endpoint;
  env.ACPUS_TUI_READ_ONLY = "1";
  if (options.runId) env.ACPUS_TUI_RUN_ID = options.runId;
  return env;
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, assets: WTermAssets, token: string): Promise<void> {
  try {
    const url = parseRequestUrl(req.url);
    if (!url) {
      sendText(res, 400, "text/plain; charset=utf-8", "bad request");
      return;
    }
    if (req.method !== "GET") {
      sendText(res, 405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }
    if (url.pathname === "/") {
      if (!isAuthorizedBridgeRequest(req, url, token)) {
        sendText(res, 403, "text/plain; charset=utf-8", "forbidden");
        return;
      }
      sendText(res, 200, "text/html; charset=utf-8", servedVisualizerHtml());
      return;
    }
    if (url.pathname === "/vendor/@wterm/dom/src/terminal.css") {
      await sendFile(res, assets.domCssPath, "text/css; charset=utf-8");
      return;
    }
    if (url.pathname === "/vendor/@wterm/core/wasm/wterm.wasm") {
      await sendFile(res, assets.coreWasmPath, "application/wasm");
      return;
    }
    if (url.pathname.startsWith("/vendor/@wterm/dom/dist/")) {
      await sendVendorFile(res, url.pathname, "/vendor/@wterm/dom/dist/", assets.domDistDir);
      return;
    }
    if (url.pathname.startsWith("/vendor/@wterm/core/dist/")) {
      await sendVendorFile(res, url.pathname, "/vendor/@wterm/core/dist/", assets.coreDistDir);
      return;
    }
    sendText(res, 404, "text/plain; charset=utf-8", "not found");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      sendText(res, 404, "text/plain; charset=utf-8", "not found");
      return;
    }
    sendText(res, 500, "text/plain; charset=utf-8", "internal server error");
  }
}

async function sendVendorFile(res: ServerResponse, pathname: string, prefix: string, baseDir: string): Promise<void> {
  const rel = pathname.slice(prefix.length);
  const filePath = normalize(join(baseDir, rel));
  if (relative(baseDir, filePath).startsWith("..")) {
    sendText(res, 403, "text/plain; charset=utf-8", "forbidden");
    return;
  }
  if (filePath.endsWith(".map")) {
    sendText(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  await sendFile(res, filePath, mimeFor(filePath));
}

async function sendFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  const data = await readFile(filePath);
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": contentType });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType });
  res.end(text);
}

function mimeFor(filePath: string): string {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR";
}

function handleWebSocketMessage(raw: WebSocket.RawData, pty: ReturnType<SpawnPty>, ws: WebSocket): void {
  try {
    const payload = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
    if (payload.type === "input" && typeof payload.data === "string") {
      pty.write(payload.data);
      return;
    }
    if (payload.type === "resize" && Number.isInteger(payload.cols) && Number.isInteger(payload.rows)) {
      pty.resize(clampDimension(payload.cols ?? DEFAULT_COLS, MAX_COLS), clampDimension(payload.rows ?? DEFAULT_ROWS, MAX_ROWS));
      return;
    }
  } catch (error) {
    sendJson(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

function clampDimension(value: number, max: number): number {
  return Math.min(max, Math.max(1, value));
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(value));
  }
}

function servedVisualizerHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Acpus Served Visualizer</title>
    <link rel="stylesheet" href="/vendor/@wterm/dom/src/terminal.css" />
    <style>
      html, body, #terminal {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #1d2021;
      }

      #terminal {
        box-sizing: border-box;
      }

      #terminal.wterm {
        --term-font-family: "SFMono-Regular", "Menlo", "Consolas", "DejaVu Sans Mono", monospace;
        height: 100%;
        padding: 14px 16px;
        border-radius: 0;
        box-shadow: none;
      }

      #terminal.wterm.theme-gruvbox-dark-hard {
        --term-bg: #1d2021;
        --term-fg: #ebdbb2;
        --term-cursor: #fe8019;
        --term-color-0: #1d2021;
        --term-color-1: #cc241d;
        --term-color-2: #98971a;
        --term-color-3: #d79921;
        --term-color-4: #458588;
        --term-color-5: #b16286;
        --term-color-6: #689d6a;
        --term-color-7: #a89984;
        --term-color-8: #928374;
        --term-color-9: #fb4934;
        --term-color-10: #b8bb26;
        --term-color-11: #fabd2f;
        --term-color-12: #83a598;
        --term-color-13: #d3869b;
        --term-color-14: #8ec07c;
        --term-color-15: #fbf1c7;
      }

      #terminal.wterm.theme-gruvbox-dark-hard ::selection {
        background: #504945;
      }
    </style>
    <script type="importmap">
      {
        "imports": {
          "@wterm/dom": "/vendor/@wterm/dom/dist/index.js",
          "@wterm/core": "/vendor/@wterm/core/dist/index.js"
        }
      }
    </script>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { WTerm } from "@wterm/dom";

      const el = document.getElementById("terminal");
      el.classList.add("theme-gruvbox-dark-hard");
      const token = new URLSearchParams(window.location.search).get("token");

      const wsUrl = new URL("/ws", window.location.href);
      wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      if (token) wsUrl.searchParams.set("token", token);
      const ws = new WebSocket(wsUrl);
      const send = (payload) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      };

      const terminal = new WTerm(el, {
        wasmUrl: "/vendor/@wterm/core/wasm/wterm.wasm",
        cursorBlink: true,
        onData: (data) => send({ type: "input", data }),
        onResize: (cols, rows) => send({ type: "resize", cols, rows })
      });

      ws.addEventListener("message", (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === "output") terminal.write(payload.data);
        if (payload.type === "exit") terminal.write("\\r\\n[served visualizer session ended]\\r\\n");
        if (payload.type === "error") terminal.write("\\r\\n[served visualizer error] " + payload.message + "\\r\\n");
      });
      ws.addEventListener("close", () => {
        terminal.write("\\r\\n[served visualizer disconnected]\\r\\n");
      });

      await terminal.init();
      terminal.focus();
    </script>
  </body>
</html>`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
