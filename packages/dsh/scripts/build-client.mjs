import { build } from "esbuild";

await build({
  entryPoints: ["src/client/index.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: [
    "@deepseek-ai/dsh-client-ui-primitives",
    "react",
    "react/jsx-runtime",
    "react-dom",
  ],
  loader: {
    ".css": "text",
    ".svg": "dataurl",
  },
  sourcemap: true,
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@acpus/dsh", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: "return module.exports; } });",
  },
});
