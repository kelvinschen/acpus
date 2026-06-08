import { describe, it, expect, afterEach } from "vitest";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { ArtifactStore } from "../../src/artifacts.js";

describe("E2E: Artifact storage", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it("stores and retrieves artifacts", async () => {
    const ir = compileYaml(`
version: 1
name: artifact-test
agents:
  coder:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: step-a
      run: agent
      use: coder
      prompt: "Produce output"
`);

    const { interpreter, store, tmpDir, cleanup } = createTestInterpreter({
      agentResponses: { "step-a": { result: "done" } }
    });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    // Write an artifact manually (in production, executors would do this)
    const artifactStore = new ArtifactStore(store.getBaseDir());
    const ref = artifactStore.write(meta.runId, "workflow/step-a", "transcript.json", JSON.stringify({ turns: [] }));
    expect(ref.uri).toContain("artifact://");

    const content = artifactStore.read(meta.runId, "workflow/step-a", "transcript.json");
    expect(JSON.parse(content.toString())).toEqual({ turns: [] });

    const refs = artifactStore.list(meta.runId, "workflow/step-a");
    expect(refs.length).toBe(1);
  });
});
