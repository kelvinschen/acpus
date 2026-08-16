import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CheckSelectionError,
  checkNames,
  createCheckRunner,
  defaultCheckNames,
  resolveCheckPlan,
} from "./check-plan.mjs";

test("the default check owns the complete non-release verification order", () => {
  assert.deepEqual(defaultCheckNames, [
    "toolchain",
    "dsh:remote",
    "graph:source",
    "graph:strict",
    "docs",
    "security",
  ]);
  assert.deepEqual(resolveCheckPlan().map(task => task.name), defaultCheckNames);
  assert(!defaultCheckNames.includes("release"));
});

test("default and release checks share the canonical DSH Remote verification", () => {
  const [remote] = resolveCheckPlan(["dsh:remote"])[0].commands;
  const release = resolveCheckPlan(["release"])[0].commands;

  assert.equal(release[0], remote);
  assert.equal(remote.args[0].endsWith("/packages/dsh/scripts/remote-artifacts.mjs"), true);
  assert.equal(remote.args[1], "check");
  assert.equal(remote.cwd.endsWith("/packages/dsh"), true);
  assert.equal(release[1].args.at(-1).endsWith("/scripts/checks/release.mjs"), true);
});

test("a named check selects one exact task", () => {
  for (const name of checkNames) {
    assert.deepEqual(resolveCheckPlan([name]).map(task => task.name), [name]);
  }
});

test("invalid selections fail before a task starts", async () => {
  assert.throws(
    () => resolveCheckPlan(["missing"]),
    error => error instanceof CheckSelectionError && /Unknown check 'missing'/u.test(error.message),
  );
  assert.throws(
    () => resolveCheckPlan(["docs", "security"]),
    error => error instanceof CheckSelectionError && /at most one/u.test(error.message),
  );
});

test("the runner stops at the first failed task", async () => {
  const started = [];
  const failure = new Error("graph failed");
  const run = createCheckRunner(async task => {
    started.push(task.name);
    if (task.name === "graph:source") throw failure;
  });

  await assert.rejects(run(), failure);
  assert.deepEqual(started, ["toolchain", "dsh:remote", "graph:source"]);
});

test("the source graph covers dead code and dependency issues in one Knip command", () => {
  const [command] = resolveCheckPlan(["graph:source"])[0].commands;
  assert(!command.args.includes("--include-entry-exports"));
  const included = command.args[command.args.indexOf("--include") + 1].split(",");
  assert.deepEqual(included, [
    "files",
    "exports",
    "nsExports",
    "types",
    "nsTypes",
    "enumMembers",
    "namespaceMembers",
    "duplicates",
    "dependencies",
    "unlisted",
    "binaries",
    "unresolved",
    "catalog",
  ]);
});

test("the strict graph remains a distinct production dependency scan", () => {
  const [command] = resolveCheckPlan(["graph:strict"])[0].commands;
  assert(command.args.includes("--strict"));
  assert(command.args.includes("--dependencies"));
  assert(!command.args.includes("--include-entry-exports"));
});

test("a late termination signal cannot turn into a successful check", {
  skip: process.platform === "win32",
}, () => {
  const preload = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (_file, _args, options) => {
      const child = originalSpawn(process.execPath, ["--eval", ""], options);
      child.once("close", () => process.emit("SIGTERM"));
      return child;
    };
    syncBuiltinESMExports();
  `;
  const result = spawnSync(process.execPath, [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL("./check.mjs", import.meta.url)),
    "docs",
  ], { encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 143, output);
  assert.match(output, /\[check:docs\] INTERRUPTED/u);
  assert.doesNotMatch(output, /\[check:docs\] PASS/u);
});
