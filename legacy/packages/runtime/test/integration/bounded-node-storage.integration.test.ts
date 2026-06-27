import { compileWorkflow } from "@acpus/core";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createTestInterpreter } from "../interpreter/helper.js";
import { nodeKeyToStorageKey } from "../../src/keys.js";

describe("Integration: bounded node storage", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((cleanup) => cleanup());
    cleanups.length = 0;
  });

  it("runs deeply nested program subworkflows without long filesystem names", async () => {
    const specDir = mkdtempSync(join(tmpdir(), "acpus-bounded-storage-spec-"));
    const childDir = join(specDir, "child");
    mkdirSync(childDir);
    cleanups.push(() => rmSync(specDir, { recursive: true, force: true }));

    const parentPath = join(specDir, "parent.yaml");
    const childPath = join(childDir, "child.yaml");
    const grandchildPath = join(childDir, "grandchild.yaml");

    writeFileSync(grandchildPath, `
version: 1
name: grandchild-bounded-storage
workflow:
  steps:
    - id: grandchild_program_with_extra_long_identifier_for_storage_validation
      run: program
      cmd: ["node", "-e", "console.log(JSON.stringify({ok:true}))"]
      capture:
        from: stdout
        parse: json
`);

    writeFileSync(childPath, `
version: 1
name: child-bounded-storage
workflow:
  steps:
    - id: child_parallel_with_extra_long_identifier_for_storage_validation
      parallel:
        - id: branch_left_with_long_human_readable_identifier
          do:
            - id: call_grandchild_left_with_long_identifier
              subworkflow: grandchild.yaml
        - id: branch_right_with_long_human_readable_identifier
          do:
            - id: call_grandchild_right_with_long_identifier
              subworkflow: grandchild.yaml
`);

    writeFileSync(parentPath, `
version: 1
name: parent-bounded-storage
input:
  items: [string]
workflow:
  steps:
    - id: parent_fanout_with_extra_long_identifier_for_storage_validation
      fanout:
        over: input.items
        key: item
        join: all
        do:
          - id: parent_loop_with_extra_long_identifier_for_storage_validation
            loop:
              max_iterations: 1
              do:
                - id: call_child_workflow_with_extra_long_identifier_for_storage_validation
                  subworkflow: child/child.yaml
`);

    const compiled = compileWorkflow(readFileSync(parentPath, "utf8"), {
      sourcePath: parentPath,
      includeResolver: () => { throw new Error("no includes expected"); }
    });
    if (!compiled.ok || !compiled.ir) {
      throw new Error(`Compilation failed: ${compiled.diagnostics.map((diagnostic) => diagnostic.message).join(", ")}`);
    }

    const { interpreter, store, cleanup } = createTestInterpreter({ useRealProgramExecutor: true });
    cleanups.push(cleanup);

    const longItem = `customer-${"very-long-stable-identifier-".repeat(10)}`;
    const meta = await interpreter.start(compiled.ir, { input: { items: [longItem] } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    const programNodes = nodes.filter((node) => node.kind === "run.program");
    expect(programNodes).toHaveLength(2);
    expect(programNodes.every((node) => node.state === "completed")).toBe(true);
    expect(programNodes.every((node) => node.nodeKey.length > 500)).toBe(true);

    const runDir = join(store.getBaseDir(), meta.runId);
    const nodeFiles = readdirSync(join(runDir, "nodes"));
    expect(nodeFiles.every((file) => file.length < 120)).toBe(true);
    expect(nodeFiles.every((file) => !file.includes(":"))).toBe(true);

    const artifactDirs = readdirSync(join(runDir, "artifacts"));
    expect(artifactDirs.every((dir) => dir.length < 120)).toBe(true);
    expect(artifactDirs.every((dir) => !dir.includes(":"))).toBe(true);

    const index = readFileSync(join(runDir, "node-index.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const node of programNodes) {
      const storageKey = nodeKeyToStorageKey(node.nodeKey);
      const entry = index.find((item) => item.nodeKey === node.nodeKey);
      expect(entry).toMatchObject({
        nodeKey: node.nodeKey,
        storageKey,
        nodeId: node.nodeId,
        kind: node.kind,
        state: node.state,
        statePath: `nodes/${storageKey}.json`,
        artifactDir: `artifacts/${storageKey}`
      });
      expect(existsSync(join(runDir, entry.statePath))).toBe(true);
      expect(existsSync(join(runDir, entry.artifactDir))).toBe(true);
    }

    const stdoutRef = programNodes[0]!.artifactRefs?.find((uri) => uri.endsWith("/stdout.log"));
    expect(stdoutRef).toBeDefined();
    expect(stdoutRef).toContain(encodeURIComponent(programNodes[0]!.nodeKey));
    const stdoutPath = store.resolveArtifactPath(stdoutRef!);
    expect(stdoutPath).toBeDefined();
    expect(basename(stdoutPath!)).toBe("stdout.log");
    expect(readFileSync(stdoutPath!, "utf8").trim()).toBe("{\"ok\":true}");
  });
});
