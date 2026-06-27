import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Program execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes a program step and returns captured output", async () => {
    const ir = compileYaml(`
version: 1
name: program-test
workflow:
  steps:
    - id: list-files
      run: program
      cmd: ["ls", "-la"]
      capture:
        from: stdout
        parse: json
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "list-files": { parsedOutput: { files: ["a.txt", "b.txt"] } }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "list-files");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: { files: ["a.txt", "b.txt"] }, exit_code: 0 });
  });

  it("executes a helper script through workflow.source_dir", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acpus-source-dir-")));
    const specPath = join(dir, "workflow.yaml");
    const scriptsDir = join(dir, "scripts");
    const helperPath = join(scriptsDir, "helper.mjs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(scriptsDir);
    writeFileSync(helperPath, "console.log(JSON.stringify({ sourceDir: process.argv[2] }))\n", "utf8");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const ir = compileYaml(`
version: 1
name: source-dir-program
workflow:
  steps:
    - id: helper
      run: program
      cmd: [${JSON.stringify(process.execPath)}, "\${{ workflow.source_dir }}/scripts/helper.mjs", "\${{ workflow.source_dir }}"]
      capture:
        from: stdout
        parse: json
      output:
        sourceDir: string
outputs:
  helper_dir: "\${{ steps.helper.output.sourceDir }}"
`);
    ir.source.path = specPath;

    const { interpreter, cleanup } = createTestInterpreter({ useRealProgramExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });

    expect(meta.status).toBe("completed");
    expect(meta.output).toEqual({ helper_dir: dir });
  });

  it("fails the node fast on a non-allow-listed non-zero exit code", async () => {
    const ir = compileYaml(`
version: 1
name: program-fail-test
workflow:
  steps:
    - id: fail-cmd
      run: program
      cmd: ["exit", "1"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "fail-cmd": { exitCode: 1, stdout: "command failed" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "fail-cmd");
    expect(node?.state).toBe("failed");
    expect(node?.error).toMatch(/exit/);
  });

  it("treats an allow-listed non-zero exit as step data", async () => {
    const ir = compileYaml(`
version: 1
name: program-expect-test
workflow:
  steps:
    - id: tested-cmd
      run: program
      cmd: ["bash", "-c", "exit 1"]
      expect:
        exit_code: [0, 1]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "tested-cmd": { exitCode: 1, stdout: "test failed" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "tested-cmd");
    expect(node?.state).toBe("completed");
    expect((node?.output as { exit_code: number }).exit_code).toBe(1);
  });

  it("evaluates program exit_code arithmetic as integer CEL", async () => {
    const ir = compileYaml(`
version: 1
name: program-exit-code-int-test
workflow:
  steps:
    - id: seed
      run: program
      cmd: ["true"]
    - id: after
      run: program
      cmd: ["echo", "\${{ steps.seed.exit_code + 1 }}"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        seed: { stdout: "" },
        after: { stdout: "ok" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const after = store.listNodeStates(meta.runId).find((n) => n.nodeId === "after");
    expect(after?.state).toBe("completed");
  });

  it("fails the node on a non-recoverable failure", async () => {
    const ir = compileYaml(`
version: 1
name: program-nonrecoverable-test
workflow:
  steps:
    - id: timeout-cmd
      run: program
      cmd: ["sleep", "100"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "timeout-cmd": { failureKind: "timeout" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "timeout-cmd");
    expect(node?.state).toBe("failed");
  });

  it("captures text output", async () => {
    const ir = compileYaml(`
version: 1
name: program-text-test
workflow:
  steps:
    - id: echo-hello
      run: program
      cmd: "echo hello"
      capture:
        from: stdout
        parse: text
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "echo-hello": { parsedOutput: "hello\n" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "echo-hello");
    expect(node?.state).toBe("completed");
    expect(node?.output).toEqual({ output: "hello\n", exit_code: 0 });
  });

  it("persists stdout.log and stderr.log artifacts", async () => {
    const ir = compileYaml(`
version: 1
name: program-artifact-test
workflow:
  steps:
    - id: emit
      run: program
      cmd: ["echo", "hi"]
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: { emit: { stdout: "stdout-content", stderr: "stderr-content" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "emit");
    expect(node?.artifactRefs?.length).toBe(2);

    const artifacts = new ArtifactStore(store.getBaseDir());
    expect(artifacts.read(meta.runId, "workflow/emit", "stdout.log").toString()).toBe("stdout-content");
    expect(artifacts.read(meta.runId, "workflow/emit", "stderr.log").toString()).toBe("stderr-content");
  });

  it("validates captured output against program output schema", async () => {
    const ir = compileYaml(`
version: 1
name: program-schema-valid
workflow:
  steps:
    - id: parse_json
      run: program
      cmd: ["echo", '{"count": 5}']
      capture:
        from: stdout
        parse: json
      output:
        count: integer
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "parse_json": { parsedOutput: { count: 5 } }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parse_json");
    expect(node?.state).toBe("completed");
    expect((node?.output as { output?: unknown })?.output).toEqual({ count: 5 });
  });

  it("preserves extra program output fields but exposes only declared fields to expressions", async () => {
    const ir = compileYaml(`
version: 1
name: program-output-projection
workflow:
  steps:
    - id: parse_json
      run: program
      cmd: ["echo", '{"ok": true, "extra": "kept"}']
      capture:
        from: stdout
        parse: json
      output:
        ok: boolean
outputs:
  projected: "\${{ steps.parse_json.output }}"
  projected_json: "\${{ json(steps.parse_json.output) }}"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "parse_json": { parsedOutput: { ok: true, extra: "kept" } }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    expect(meta.output).toEqual({
      projected: { ok: true },
      projected_json: '{"ok":true}'
    });

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parse_json");
    expect(node?.output).toEqual({ output: { ok: true, extra: "kept" }, exit_code: 0 });
  });

  it("fails the node when captured output does not match program output schema", async () => {
    const ir = compileYaml(`
version: 1
name: program-schema-invalid
workflow:
  steps:
    - id: parse_json
      run: program
      cmd: ["echo", '{"count": "not-a-number"}']
      capture:
        from: stdout
        parse: json
      output:
        count: integer
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "parse_json": { parsedOutput: { count: "not-a-number" } }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parse_json");
    expect(node?.state).toBe("failed");
    expect(node?.error).toContain("Program step 'parse_json' failed (schema)");
    expect(node?.error).toContain("Output validation failed:");
    expect(node?.error).toContain("must be integer");
    expect(node?.error).toContain("captured output preview:");
    expect(node?.error).toContain('{"count":"not-a-number"}');
  });

  it("truncates captured output preview for long program schema failures", async () => {
    const longValue = "x".repeat(3000);
    const ir = compileYaml(`
version: 1
name: program-schema-invalid-long
workflow:
  steps:
    - id: parse_json
      run: program
      cmd: ["echo", "{}"]
      capture:
        from: stdout
        parse: json
      output:
        count: integer
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "parse_json": {
          stdout: JSON.stringify({ count: longValue }),
          parsedOutput: { count: longValue }
        }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parse_json");
    expect(node?.state).toBe("failed");
    expect(node?.error).toContain("captured output preview:");
    expect(node?.error).toContain("[truncated, 3012 chars total]");
    expect(node?.error).not.toContain(longValue);
  });

  it("does not validate output when no output schema is declared", async () => {
    const ir = compileYaml(`
version: 1
name: program-no-schema
workflow:
  steps:
    - id: parse_json
      run: program
      cmd: ["echo", "hello"]
      capture:
        from: stdout
        parse: json
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      programResponses: {
        "parse_json": { parsedOutput: { anything: "goes", number: 42 } }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "parse_json");
    expect(node?.state).toBe("completed");
  });
});
