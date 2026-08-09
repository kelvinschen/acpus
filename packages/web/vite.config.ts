import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function packageChunk(id: string): string | null {
  const path = id.replaceAll("\\", "/");
  if (!path.includes("/node_modules/")) return null;

  if (matchesPackage(path, ["react", "react-dom", "scheduler"])) return "vendor-react";
  if (path.includes("/@radix-ui/")) return "vendor-radix";
  if (matchesPackage(path, ["@tanstack/react-query", "@tanstack/query-core"])) return "vendor-query";
  if (matchesPackage(path, ["lucide-react"])) return "vendor-icons";
  if (matchesPackage(path, ["react-json-view-lite"])) return "vendor-json-view";
  if (matchesPackage(path, ["@vercel/beautiful-mermaid", "@dagrejs/dagre"])) return "feature-mermaid";
  return "vendor";
}

function matchesPackage(path: string, names: readonly string[]): boolean {
  return names.some(name => {
    const escaped = name.replace("/", "\\/");
    return new RegExp(`/node_modules/(?:\\.pnpm/[^/]+/node_modules/)?${escaped}(?:/|$)`).test(path);
  });
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: packageChunk }],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api/": "http://localhost:4517",
    },
  },
});
