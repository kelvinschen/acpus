import { describe, expect, it } from "vitest";
import { startWebServer } from "../src/server/launcher.js";

describe("startWebServer access policy", () => {
  it("does not generate a token for network hosts by default", async () => {
    const server = await startWebServer({ cwd: process.cwd(), host: "0.0.0.0" });
    try {
      expect(server.token).toBeUndefined();
      expect(server.url).not.toContain("token=");
    } finally {
      await server.close();
    }
  });

  it("generates a token only when requested", async () => {
    const server = await startWebServer({ cwd: process.cwd(), token: true });
    try {
      expect(server.token).toBeDefined();
      expect(server.url).toContain(`token=${encodeURIComponent(server.token!)}`);
    } finally {
      await server.close();
    }
  });

  it("allows repeated close calls", async () => {
    const server = await startWebServer({ cwd: process.cwd() });

    await Promise.all([server.close(), server.close(), server.close()]);
    await server.close();
  });
});
