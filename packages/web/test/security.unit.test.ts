import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createAccessPolicy, requireToken } from "../src/server/security.js";
import { ApiError } from "../src/server/errors.js";

type JsonBody = Record<string, any>;

describe("createAccessPolicy", () => {
  it("returns empty policy by default", () => {
    const policy = createAccessPolicy();
    expect(policy.token).toBeUndefined();
  });

  it("returns empty policy when token access is disabled", () => {
    const policy = createAccessPolicy({ enabled: false });
    expect(policy.token).toBeUndefined();
  });

  it("generates consistent 24-byte base64url token", () => {
    const policy = createAccessPolicy({ enabled: true });
    const tokenBytes = Buffer.from(policy.token!, "base64url");
    expect(tokenBytes.length).toBe(24);
  });

});

describe("requireToken middleware", () => {
  function appWith(policy: ReturnType<typeof createAccessPolicy>) {
    const app = new Hono();
    app.use("*", requireToken(policy));
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.onError((error, c) => {
      if (error instanceof ApiError) {
        c.status(error.status as any);
        return c.json({ ok: false, error: { code: error.code, message: error.message } });
      }
      c.status(500);
      return c.json({ ok: false, error: { code: "internal_error", message: error.message } });
    });
    return app;
  }

  it("returns 401 when no token is provided for protected access", async () => {
    const policy = createAccessPolicy({ enabled: true });
    const app = appWith(policy);
    const res = await app.request("/api/health");
    expect(res.status).toBe(401);
    const body = await res.json() as JsonBody;
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects wrong Bearer tokens with equal or different byte lengths", async () => {
    const policy = createAccessPolicy({ enabled: true });
    const app = appWith(policy);
    for (const token of ["wrong-token", "x".repeat(policy.token!.length)]) {
      const res = await app.request("/api/health", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it("sets cookie when token comes from query param", async () => {
    const policy = createAccessPolicy({ enabled: true });
    const app = appWith(policy);
    const res = await app.request(`/api/health?token=${policy.token}`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("acpus_web_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=86400");
  });

  it("does not set cookie when token comes from header", async () => {
    const policy = createAccessPolicy({ enabled: true });
    const app = appWith(policy);
    const res = await app.request("/api/health", {
      headers: { authorization: `Bearer ${policy.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts token from cookie", async () => {
    const policy = createAccessPolicy({ enabled: true });
    const app = appWith(policy);
    const res = await app.request("/api/health", {
      headers: { cookie: `acpus_web_token=${encodeURIComponent(policy.token!)}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects token from cookie when value is wrong", async () => {
    const policy = createAccessPolicy({ enabled: true });
    const app = appWith(policy);
    const res = await app.request("/api/health", {
      headers: { cookie: "acpus_web_token=wrong" },
    });
    expect(res.status).toBe(401);
  });
});
