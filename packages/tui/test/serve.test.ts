import { EventEmitter } from "node:events";
import { connect } from "node:net";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { parseListen, startServedVisualizerBridge } from "../src/serve.js";

describe("served visualizer bridge", () => {
  it("parses listen values", () => {
    expect(parseListen(undefined)).toEqual({ host: "127.0.0.1", port: 0 });
    expect(parseListen(true)).toEqual({ host: "127.0.0.1", port: 0 });
    expect(parseListen("3000")).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(parseListen("127.0.0.1:3000")).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(parseListen("0.0.0.0:3000")).toEqual({ host: "0.0.0.0", port: 3000 });
    expect(() => parseListen("run_abc")).toThrow(/run id before --serve/i);
    expect(() => parseListen(false)).toThrow(/run id before --serve/i);
    expect(() => parseListen("127.0.0.1:70000")).toThrow(/Port must be an integer/);
  });

  it("reports occupied ports", async () => {
    const first = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory()
    });
    try {
      await expect(startServedVisualizerBridge({
        endpoint: "http://127.0.0.1:1",
        listen: `127.0.0.1:${first.port}`,
        spawnPty: fakePtyFactory()
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });

  it("kills a PTY child when the websocket closes", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    const ws = openBridgeWebSocket(bridge);
    await once(ws, "open");
    expect(bridge.activeClientCount()).toBe(1);
    ws.close();
    await waitFor(() => ptys[0]?.killed === true);
    expect(bridge.activeClientCount()).toBe(0);
    await bridge.close();
  });

  it("closes a websocket and cleans up the client when the PTY child exits", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    const ws = openBridgeWebSocket(bridge);
    await once(ws, "open");
    const exitMessage = onceMessage(ws);
    const closed = once(ws, "close");
    ptys[0].emitExit(0);

    expect(JSON.parse((await exitMessage).toString())).toEqual({ type: "exit", exitCode: 0 });
    await closed;
    await waitFor(() => bridge.activeClientCount() === 0);
    expect(ptys[0].killed).toBe(false);
    await bridge.close();
  });

  it("starts an independent PTY child for each websocket connection", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    const first = openBridgeWebSocket(bridge);
    const second = openBridgeWebSocket(bridge);
    await Promise.all([once(first, "open"), once(second, "open")]);

    expect(bridge.activeClientCount()).toBe(2);
    expect(ptys).toHaveLength(2);
    expect(ptys[0]).not.toBe(ptys[1]);

    const firstMessage = onceMessage(first);
    const secondMessage = onceMessage(second);
    ptys[0].emitData("first");
    ptys[1].emitData("second");

    expect(JSON.parse((await firstMessage).toString())).toEqual({ type: "output", data: "first" });
    expect(JSON.parse((await secondMessage).toString())).toEqual({ type: "output", data: "second" });

    first.close();
    second.close();
    await bridge.close();
  });

  it("forwards websocket input and resize messages to the PTY child", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    const ws = openBridgeWebSocket(bridge);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "input", data: "j" }));
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await waitFor(() => ptys[0]?.writes.length === 1 && ptys[0]?.sizes.length === 1);
    expect(ptys[0].writes).toEqual(["j"]);
    expect(ptys[0].sizes).toEqual([{ cols: 100, rows: 30 }]);
    ws.close();
    await bridge.close();
  });

  it("clamps websocket resize messages before forwarding them to the PTY child", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    const ws = openBridgeWebSocket(bridge);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "resize", cols: 999999, rows: 0 }));
    await waitFor(() => ptys[0]?.sizes.length === 1);
    expect(ptys[0].sizes).toEqual([{ cols: 500, rows: 1 }]);
    ws.close();
    await bridge.close();
  });

  it("serves the browser page and static assets with security headers", async () => {
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory()
    });
    try {
      const html = await fetch(bridgeHttpUrl(bridge, "/"));
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("x-content-type-options")).toBe("nosniff");
      expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(html.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
      expect(await html.text()).toContain("<title>Acpus Served Visualizer</title>");

      const css = await fetch(`http://127.0.0.1:${bridge.port}/vendor/@wterm/dom/src/terminal.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");

      const wasm = await fetch(`http://127.0.0.1:${bridge.port}/vendor/@wterm/core/wasm/wterm.wasm`);
      expect(wasm.status).toBe(200);
      expect(wasm.headers.get("content-type")).toContain("application/wasm");
    } finally {
      await bridge.close();
    }
  });

  it("returns 404 for unknown paths and source maps", async () => {
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory()
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${bridge.port}/missing`);
      expect(missing.status).toBe(404);

      const sourceMap = await fetch(`http://127.0.0.1:${bridge.port}/vendor/@wterm/dom/dist/index.js.map`);
      expect(sourceMap.status).toBe(404);
    } finally {
      await bridge.close();
    }
  });

  it("rejects the browser page and websocket when the bridge token is missing", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    try {
      const html = await fetch(`http://127.0.0.1:${bridge.port}/`);
      expect(html.status).toBe(403);

      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
      ws.on("error", () => {});
      await once(ws, "close");
      expect(ptys).toHaveLength(0);
      expect(bridge.activeClientCount()).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("rejects cross-origin websocket upgrades even with the bridge token", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    try {
      const ws = openBridgeWebSocket(bridge, { Origin: "https://attacker.example" });
      ws.on("error", () => {});
      await once(ws, "close");
      expect(ptys).toHaveLength(0);
      expect(bridge.activeClientCount()).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("accepts same-origin browser websocket upgrades with the bridge token", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    try {
      const ws = openBridgeWebSocket(bridge, { Origin: `http://127.0.0.1:${bridge.port}` });
      await once(ws, "open");
      expect(ptys).toHaveLength(1);
      expect(bridge.activeClientCount()).toBe(1);
      ws.close();
    } finally {
      await bridge.close();
    }
  });

  it("rejects websocket connections above the client cap without spawning a PTY", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys),
      maxClients: 1
    });
    const first = openBridgeWebSocket(bridge);
    await once(first, "open");

    const second = openBridgeWebSocket(bridge);
    const secondMessage = onceMessage(second);
    await once(second, "open");
    expect(JSON.parse((await secondMessage).toString())).toMatchObject({
      type: "error",
      message: expect.stringContaining("client limit")
    });
    await once(second, "close");

    expect(ptys).toHaveLength(1);
    expect(bridge.activeClientCount()).toBe(1);
    first.close();
    await bridge.close();
  });

  it("closes oversized websocket messages without forwarding them to the PTY child", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    const ws = openBridgeWebSocket(bridge);
    ws.on("error", () => {});
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "input", data: "x".repeat(1024 * 1024) }));
    await once(ws, "close");

    expect(ptys[0].writes).toEqual([]);
    expect(ptys[0].killed).toBe(true);
    expect(bridge.activeClientCount()).toBe(0);
    await bridge.close();
  });

  it("returns generic 404s for missing vendor files without leaking local paths", async () => {
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory()
    });
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/vendor/@wterm/dom/dist/not-real.js`);
      const text = await response.text();
      expect(response.status).toBe(404);
      expect(text).toBe("not found");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("node_modules");
    } finally {
      await bridge.close();
    }
  });

  it("rejects non-GET HTTP methods", async () => {
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory()
    });
    try {
      const response = await fetch(bridgeHttpUrl(bridge, "/"), { method: "POST" });
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("method not allowed");
    } finally {
      await bridge.close();
    }
  });

  it("returns a generic 400 for malformed request targets and keeps the bridge alive", async () => {
    const ptys: FakePty[] = [];
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: fakePtyFactory(ptys)
    });
    try {
      const malformedHttp = await rawHttpRequest(bridge.port, [
        "GET http://[ HTTP/1.1",
        `Host: 127.0.0.1:${bridge.port}`,
        "",
        ""
      ].join("\r\n"));
      expect(malformedHttp).toContain("400 Bad Request");

      const malformedUpgrade = await rawHttpRequest(bridge.port, [
        "GET http://[ HTTP/1.1",
        `Host: 127.0.0.1:${bridge.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "",
        ""
      ].join("\r\n"));
      expect(malformedUpgrade).toContain("400 Bad Request");
      expect(ptys).toHaveLength(0);

      const valid = await fetch(bridgeHttpUrl(bridge, "/"));
      expect(valid.status).toBe(200);
    } finally {
      await bridge.close();
    }
  });

  it("reports PTY spawn failures without crashing the bridge", async () => {
    const bridge = await startServedVisualizerBridge({
      endpoint: "http://127.0.0.1:1",
      listen: "127.0.0.1:0",
      spawnPty: () => {
        throw new Error("pty unavailable");
      }
    });
    const ws = openBridgeWebSocket(bridge);
    const message = await onceMessage(ws);
    expect(JSON.parse(message.toString())).toMatchObject({
      type: "error",
      message: expect.stringContaining("pty unavailable")
    });
    await waitFor(() => bridge.activeClientCount() === 0);
    await bridge.close();
  });
});

class FakePty {
  readonly events = new EventEmitter();
  killed = false;
  writes: string[] = [];
  sizes: Array<{ cols: number; rows: number }> = [];

  onData(listener: (data: string) => void) {
    this.events.on("data", listener);
    return { dispose: () => this.events.off("data", listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.events.on("exit", listener);
    return { dispose: () => this.events.off("exit", listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    this.events.emit("data", data);
  }

  emitExit(exitCode: number): void {
    this.events.emit("exit", { exitCode });
  }
}

function fakePtyFactory(out: FakePty[] = []) {
  return () => {
    const pty = new FakePty();
    out.push(pty);
    return pty;
  };
}

function bridgeHttpUrl(bridge: { port: number; token: string }, pathname: string): string {
  const url = new URL(`http://127.0.0.1:${bridge.port}${pathname}`);
  url.searchParams.set("token", bridge.token);
  return url.toString();
}

function openBridgeWebSocket(bridge: { port: number; token: string }, headers?: Record<string, string>): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${bridge.token}`, { headers });
}

function rawHttpRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n0\r\n\r\n")) finish(response);
    });
    socket.on("end", () => finish(response));
    socket.on("close", () => finish(response));
    socket.on("timeout", () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for raw HTTP response. Response so far:\n${response}`));
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function once(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => {
    emitter.once(event, () => resolve());
  });
}

function onceMessage(ws: WebSocket): Promise<WebSocket.RawData> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
