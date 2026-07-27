import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceGraphIssues = [
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
].join(",");

const tasks = new Map([
  ["toolchain", {
    name: "toolchain",
    commands: [
      nodeCommand("scripts/checks/toolchain.mjs"),
      {
        file: process.execPath,
        args: [
          "--test",
          join(root, "scripts", "build-plan.test.mjs"),
          join(root, "scripts", "check-plan.test.mjs"),
        ],
        cwd: root,
      },
    ],
  }],
  ["graph:source", {
    name: "graph:source",
    commands: [{
      packageBin: ["knip", "knip"],
      args: [
        "--include-entry-exports",
        "--include",
        sourceGraphIssues,
        "--treat-config-hints-as-errors",
      ],
      cwd: root,
    }],
  }],
  ["graph:strict", {
    name: "graph:strict",
    commands: [{
      packageBin: ["knip", "knip"],
      args: [
        "--strict",
        "--dependencies",
        "--treat-config-hints-as-errors",
      ],
      cwd: root,
    }],
  }],
  ["docs", {
    name: "docs",
    commands: [nodeCommand("scripts/checks/docs.mjs")],
  }],
  ["security", {
    name: "security",
    commands: [{
      packageManager: true,
      args: ["audit", "--audit-level", "high"],
      cwd: root,
    }],
  }],
  ["release", {
    name: "release",
    commands: [nodeCommand("scripts/checks/release.mjs")],
  }],
]);

export const checkNames = Object.freeze([...tasks.keys()]);
export const defaultCheckNames = Object.freeze([
  "toolchain",
  "graph:source",
  "graph:strict",
  "docs",
  "security",
]);

export class CheckSelectionError extends Error {}

export function resolveCheckPlan(selection = []) {
  if (selection.length > 1) {
    throw new CheckSelectionError("Expected at most one check name.");
  }
  const names = selection.length === 0 ? defaultCheckNames : selection;
  return names.map(name => {
    const task = tasks.get(name);
    if (!task) {
      throw new CheckSelectionError(
        `Unknown check '${name}'. Expected one of: ${checkNames.join(", ")}.`,
      );
    }
    return task;
  });
}

export function createCheckRunner(executeTask) {
  return async function runChecks(selection = []) {
    const completed = [];
    for (const task of resolveCheckPlan(selection)) {
      await executeTask(task);
      completed.push(task.name);
    }
    return completed;
  };
}

function nodeCommand(relativePath) {
  return {
    file: process.execPath,
    args: [join(root, relativePath)],
    cwd: root,
  };
}
