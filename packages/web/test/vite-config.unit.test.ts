import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

describe("web Vite configuration", () => {
  it("proxies backend routes without intercepting the client api module", () => {
    expect(viteConfig.server?.proxy).toEqual({
      "/api/": "http://localhost:4517",
    });
  });
});
