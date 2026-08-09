import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

type ChunkGroup = {
  name(id: string): string | null;
};

const build = viteConfig.build;
const output = build?.rolldownOptions?.output as {
  codeSplitting?: { groups?: ChunkGroup[] };
} | undefined;
const chunkName = output?.codeSplitting?.groups?.[0]?.name;

describe("web Vite configuration", () => {
  it.each([
    ["React", "/repo/node_modules/react/index.js", "vendor-react"],
    ["pnpm React", "/repo/node_modules/.pnpm/react@19.1.0/node_modules/react/index.js", "vendor-react"],
    ["Radix", "/repo/node_modules/@radix-ui/react-dialog/index.js", "vendor-radix"],
    ["TanStack Query", "/repo/node_modules/@tanstack/react-query/index.js", "vendor-query"],
    ["icons", "/repo/node_modules/lucide-react/index.js", "vendor-icons"],
    ["JSON viewer", "/repo/node_modules/react-json-view-lite/index.js", "vendor-json-view"],
    ["Mermaid renderer", "/repo/node_modules/@vercel/beautiful-mermaid/dist/index.js", "feature-mermaid"],
    ["pnpm Mermaid layout", "/repo/node_modules/.pnpm/@dagrejs+dagre@1.1.8/node_modules/@dagrejs/dagre/index.js", "feature-mermaid"],
    ["other dependency", "/repo/node_modules/other/index.js", "vendor"],
    ["application source", "/repo/src/client/app.tsx", null],
  ])("assigns %s modules to the intended chunk", (_label, id, expected) => {
    expect(chunkName).toBeTypeOf("function");
    expect(chunkName?.(id)).toBe(expected);
  });

  it("gives Vite sole ownership of the client output directory", () => {
    expect(build).toMatchObject({
      outDir: "../../dist/client",
      emptyOutDir: true,
    });
  });

  it("proxies backend routes without intercepting the client api module", () => {
    expect(viteConfig.server?.proxy).toEqual({
      "/api/": "http://localhost:4517",
    });
  });
});
