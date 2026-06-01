import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  platform: "node",
  target: "node22",
  deps: {
    alwaysBundle: [/^(commander|proper-lockfile|zod|jsonrepair)(\/.*)?$/],
    onlyBundle: false,
    dts: {
      neverBundle: [/^zod(\/.*)?$/]
    }
  }
});
