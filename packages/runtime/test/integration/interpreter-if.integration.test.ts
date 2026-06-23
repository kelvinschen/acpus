import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";

describe("If execution", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("executes only the then branch when condition is true", async () => {
    const ir = compileYaml(`
version: 1
name: if-then-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then:
          - id: then-path
            run: agent
            use: coder
            prompt: "Then"
        else:
          - id: else-path
            run: agent
            use: coder
            prompt: "Else"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "then-path": { branch: "then" },
        "else-path": { branch: "else" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { enabled: true } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "then-path")?.state).toBe("completed");
    expect(nodes.find((n) => n.nodeId === "else-path")).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === "maybe")?.output).toEqual({ output: { branch: "then" } });
  });

  it("executes only the else branch when condition is false and else exists", async () => {
    const ir = compileYaml(`
version: 1
name: if-else-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then:
          - id: then-path
            run: agent
            use: coder
            prompt: "Then"
        else:
          - id: else-path
            run: agent
            use: coder
            prompt: "Else"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "then-path": { branch: "then" },
        "else-path": { branch: "else" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { enabled: false } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "then-path")).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === "else-path")?.state).toBe("completed");
    expect(nodes.find((n) => n.nodeId === "maybe")?.output).toEqual({ output: { branch: "else" } });
  });

  it("completes with empty output when condition is false and else is omitted", async () => {
    const ir = compileYaml(`
version: 1
name: if-no-else-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: maybe
      if:
        condition: input.enabled
        then:
          - id: then-path
            run: agent
            use: coder
            prompt: "Then"
`);

    const { interpreter, store, cleanup } = createTestInterpreter({
      agentResponses: {
        "then-path": { branch: "then" }
      }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { enabled: false } });
    expect(meta.status).toBe("completed");

    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.find((n) => n.nodeId === "then-path")).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === "maybe")?.state).toBe("completed");
    expect(nodes.find((n) => n.nodeId === "maybe")?.output).toEqual({ output: {} });
  });
});
