import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "./helper.js";

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
    expect(node?.output).toEqual({ files: ["a.txt", "b.txt"] });
  });

  it("fails on non-zero exit code", async () => {
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
    expect(node?.output).toBe("hello\n");
  });
});
