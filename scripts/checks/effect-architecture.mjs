import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

const promiseAdapters = new Set([
  "packages/cli/src/agent/command.ts",
  "packages/cli/src/cli.ts",
  "packages/cli/src/doctor/command.ts",
  "packages/cli/src/hooks/command.ts",
  "packages/cli/src/presentation/json-input.ts",
  "packages/cli/src/runs/artifacts.ts",
  "packages/cli/src/runs/controls.ts",
  "packages/cli/src/runs/deletion.ts",
  "packages/cli/src/runs/inspection.ts",
  "packages/cli/src/skill/command.ts",
  "packages/cli/src/web/command.ts",
  "packages/cli/src/workflow/catalog.ts",
  "packages/cli/src/workflow/command.ts",
  "packages/cli/src/workflow/import/index.ts",
  "packages/cli/src/workflow/import/package.ts",
  "packages/cli/src/workflow/preparation.ts",
  "packages/dsh/src/host/mode.ts",
  "packages/dsh/src/host/tools.ts",
  "packages/tasks/src/git.ts",
  "packages/web/src/client/api/transport.ts",
  "packages/web/src/server/routes/artifacts.ts",
  "packages/web/src/server/routes/inspection-controls.ts",
  "packages/web/src/server/routes/runs.ts",
  "packages/web/src/server/routes/system.ts",
  "packages/web/src/server/routes/workflows.ts",
  "packages/web/src/server/workspace-context.ts",
  "packages/workflow-compiler/src/compiler/compile-worker.ts",
  "packages/workflow-compiler/src/preflight/index.ts",
]);

const nodeRuntimeRoots = new Set([
  "packages/agent-executor/src/worker-entry.ts",
  "packages/cli/src/daemon-entry.ts",
]);

const directChildProcessAdapters = new Set([
  "packages/cli/src/daemon/client.ts",
  "packages/cli/src/update/awareness.ts",
  "packages/core/src/runtime/dollar.ts",
  "packages/owned-process/src/node.ts",
  "packages/workflow-compiler/src/typescript/native.ts",
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];

for (const path of await sourceFiles(join(root, "packages"))) {
  const display = relative(root, path);
  const source = await readFile(path, "utf8");
  const specifiers = moduleSpecifiers(source);

  if (specifiers.includes("effect")) {
    failures.push(`${display}: import Effect through public module subpaths, not the root barrel`);
  }
  for (const specifier of specifiers) {
    if (specifier.startsWith("effect/unstable/")) {
      failures.push(`${display}: unstable Effect imports require an explicit architecture decision`);
    }
  }

  if (!display.includes("/src/")) continue;

  if (specifiers.includes("node:child_process") && !directChildProcessAdapters.has(display)) {
    failures.push(`${display}: owned child processes must use ProcessHost`);
  }

  inspectRuntimeCalls(display, source, failures);
}

if (failures.length > 0) {
  console.error([...new Set(failures)].sort().join("\n"));
  process.exitCode = 1;
} else {
  console.log("Effect architecture is valid.");
}

function inspectRuntimeCalls(path, source, output) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  for (const match of code.matchAll(/\bEffect\.(runPromise(?:Exit)?|runFork|runSync(?:Exit)?)\s*\(/gu)) {
    checkRunner(path, match[1], output);
  }
  if (/\bNodeRuntime\.runMain\s*\(/u.test(code) && !nodeRuntimeRoots.has(path)) {
    output.push(`${path}: NodeRuntime.runMain is allowed only at executable roots`);
  }
}

function checkRunner(path, operation, output) {
  if (operation === "runPromise" || operation === "runPromiseExit") {
    if (!promiseAdapters.has(path)) output.push(`${path}: Effect Runtime execution belongs at an explicit adapter`);
  } else if (["runFork", "runSync", "runSyncExit"].includes(operation)) {
    output.push(`${path}: ${operation} is not an approved production Runtime boundary`);
  }
}

function moduleSpecifiers(source) {
  const values = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?["']([^"']+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']/gu,
  ]) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return values;
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["coverage", "dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (sourceExtensions.has(extname(path))) result.push(path);
  }
  return result;
}
