import { afterEach, describe, expect, it, vi } from "vitest";
import { getArtifactPreview, listRuns, WebApiError } from "../src/client/api.js";

describe("Web API transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps network failures distinct from server responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));

    await expect(listRuns()).rejects.toMatchObject({
      failure: { type: "network-failed", message: "connection lost" },
    });
  });

  it("preserves a valid server error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: { code: "store_busy", message: "Try again." },
    }), { status: 503, headers: { "content-type": "application/json" } })));

    await expect(listRuns()).rejects.toMatchObject({
      failure: { type: "request-failed", status: 503, code: "store_busy", message: "Try again." },
    });
  });

  it("rejects an HTML error body as invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>failed</html>", { status: 500 })));

    await expect(listRuns()).rejects.toMatchObject({
      failure: { type: "response-invalid-json", status: 500 },
    });
  });

  it("rejects a successful envelope with the wrong endpoint shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, runs: {} }), { status: 200 })));

    const failure = await listRuns().catch(error => error);
    expect(failure).toBeInstanceOf(WebApiError);
    expect(failure.failure).toMatchObject({ type: "response-invalid-envelope", status: 200 });
  });

  it("returns a minimally validated successful result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      runs: [{ id: "run_1", name: "test", status: "running" }],
    }), { status: 200 })));

    await expect(listRuns()).resolves.toEqual([{ id: "run_1", name: "test", status: "running" }]);
  });

  it("preserves the server error envelope for artifact previews", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: { code: "artifact_corrupt", message: "Artifact is corrupt." },
    }), { status: 500 })));

    await expect(getArtifactPreview("run_1", "artifact_1")).rejects.toMatchObject({
      failure: { type: "request-failed", status: 500, code: "artifact_corrupt", message: "Artifact is corrupt." },
    });
  });
});
