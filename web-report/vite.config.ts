import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "..", "dist", "report-web"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500
  }
});
