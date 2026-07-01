import parser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

const acpusInternal = await loadAcpusInternalPlugin();

export default defineConfig([
  {
    files: ["fixtures/workflows/**/*.{ts,tsx}"],
    languageOptions: {
      parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module",
      },
    },
    plugins: {
      "acpus-internal": acpusInternal,
    },
    rules: acpusInternal.rules?.check ? {
      "acpus-internal/check": "error",
    } : {},
  },
]);

async function loadAcpusInternalPlugin() {
  try {
    const plugin = await import("@acpus/workflow-compiler/internal/eslint-plugin");
    return plugin.default;
  } catch (error) {
    if (!isMissingBuiltPlugin(error)) throw error;
    return { rules: {} };
  }
}

function isMissingBuiltPlugin(error) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? String(error.message) : "";
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    && (message.includes("@acpus/workflow-compiler/internal/eslint-plugin")
      || message.includes("workflow-compiler/dist/internal/eslint-plugin"));
}
