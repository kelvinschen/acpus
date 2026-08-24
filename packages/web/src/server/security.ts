import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { apiError } from "./errors.js";

export type AccessPolicy = {
  token?: string;
};

export type AccessPolicyOptions = {
  enabled?: boolean;
};

export function createAccessPolicy(options: AccessPolicyOptions = {}): AccessPolicy {
  if (!options.enabled) return {};
  const token = randomBytes(24).toString("base64url");
  return { token };
}

export function requireToken(policy: AccessPolicy): MiddlewareHandler {
  return async (context, next) => {
    if (!policy.token) {
      await next();
      return;
    }
    const header = context.req.header("authorization") ?? "";
    const token = [
      header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined,
      context.req.query("token"),
      cookieToken(context.req.header("cookie")),
    ].find(value => value !== undefined);

    if (token === undefined || !sameToken(token, policy.token))
      apiError(401, "unauthorized", "Bearer token is required.");

    const shouldSetCookie = context.req.query("token") === token;
    await next();
    if (shouldSetCookie) {
      context.header("set-cookie", `acpus_web_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    }
  };
}

function sameToken(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function cookieToken(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  for (const entry of cookie.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (name === "acpus_web_token") return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
