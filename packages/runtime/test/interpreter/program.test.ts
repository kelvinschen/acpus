import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";
import { ArtifactStore } from "../../src/artifacts.js";

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

  it("treats a non-zero exit code as step data", async () => {
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
    expect(meta.status).toBe("completed");

    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "fail-cmd");
    expect(node?.state).toBe("completed");
    expect((node?.output as { exit_code: number }).exit_code).toBe(1);
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
    expect(node?.error).toContain("schema");
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
