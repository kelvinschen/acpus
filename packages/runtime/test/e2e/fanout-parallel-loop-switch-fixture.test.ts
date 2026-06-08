import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileWorkflow } from "@acpus/core";
import { buildRenderTree, buildRows } from "../../../tui/src/model.js";
import { createTestInterpreter } from "../interpreter/helper.js";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);

const fixtures = join(import.meta.dirname, "../../../core/test/fixtures");
const fixturePath = join(fixtures, "fanout-parallel-loop-switch-tui/workflow.yaml");

/**
 * Real E2E: the workflow uses `type: command` + `acpus-mock-agent --script`
 * which goes through acpx as a real ACP server. Agent output arrives as
 * `{ text: "..." }` from the ACP stream; JSON payloads are extracted by the
 * AgentExecutor's extractJson logic, so the output envelope is
 * `{ output: { branch, lane, ... } }`.
 *
 * Each test gets an isolated HOME so acpx session metadata (`~/.acpx`) does
 * not leak across tests.
 */
describe("E2E: fanout/parallel/loop/switch TUI fixture", () => {
  const cleanups: Array<() => void> = [];
  const homeDirs: string[] = [];

  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
    for (const h of homeDirs) {
      try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    homeDirs.length = 0;
  });

  function makeIsolatedHome(): string {
    const home = mkdtempSync(join(tmpdir(), "acpus-tui-home-"));
    homeDirs.push(home);
    return home;
  }

  /** Read and patch the fixture workflow for E2E: absolute mock-agent path, HOME isolation, trace redirect. */
  function patchWorkflowSource(home: string): string {
    const mockAgentEntry = require.resolve("@acpus/mock-agent");
    const mockScriptPath = join(fixtures, "fanout-parallel-loop-switch-tui/mock.yaml");
    const tracePath = join(home, "mock-trace.jsonl");
    return readFileSync(fixturePath, "utf8")
      .replace(
        /use: "acpus-mock-agent --script \.\/packages\/core\/test\/fixtures\/fanout-parallel-loop-switch-tui\/mock\.yaml"/,
        `use: "${process.execPath} ${mockAgentEntry} --script ${mockScriptPath} --trace ${tracePath} --trace-mode overwrite"`
      )
      // Inject HOME isolation env
      .replace(
        /cwd: "\."/,
        `cwd: "."\n    env:\n      HOME: "${home}"`
      );
  }

  it("executes the nested mock workflow with default input values", async () => {
    const home = makeIsolatedHome();
    const source = patchWorkflowSource(home);
    const compiled = compileWorkflow(source, { sourcePath: fixturePath });
    expect(compiled.ok).toBe(true);
    const ir = compiled.ir!;

    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");

    const storedInput = store.readInput(meta.runId);
    expect(storedInput).toEqual({ lanes: ["alpha", "beta", "gamma"], max_rounds: 3, route_mode: "default" });

    const nodes = store.listNodeStates(meta.runId);
    const fanout = nodes.find((n) => n.nodeId === "fanout_parallel_loop_switch");
    expect(fanout?.state).toBe("completed");
    expect(fanout?.output).toHaveLength(3);

    const laneParallel = nodes.filter((n) => n.nodeId === "lane_parallel");
    expect(laneParallel).toHaveLength(3);

    const reviewNodes = nodes.filter((n) => n.nodeId === "review_lane");
    expect(reviewNodes).toHaveLength(3);
    for (const n of reviewNodes) {
      expect(n.nodeKey).toMatch(/item:(alpha|beta|gamma)/);
      expect(n.nodeKey).toMatch(/lane:[012]/);
      expect(n.nodeKey).toMatch(/branch:0/);
      // ACP path: output is wrapped in { output: { branch, lane, ok } }
      expect(n.output).toEqual({ output: { branch: "review", lane: "fixture", ok: true } });
    }

    const loopNodes = nodes.filter((n) => n.nodeId === "loop_agent");
    expect(loopNodes).toHaveLength(9);
    for (const n of loopNodes) {
      expect(n.nodeKey).toMatch(/lane:[012]/);
      expect(n.nodeKey).toMatch(/branch:1/);
      expect(n.nodeKey).toMatch(/round:[012]/);
    }

    const switchAlpha = nodes.filter((n) => n.nodeId === "switch_alpha_agent");
    const switchDefault = nodes.filter((n) => n.nodeId === "switch_default_agent");
    const switchFallback = nodes.filter((n) => n.nodeId === "switch_fallback_agent");
    expect(switchAlpha).toHaveLength(1);
    expect(switchAlpha[0]?.nodeKey).toContain("item:alpha");
    expect(switchDefault).toHaveLength(2);
    expect(switchFallback).toHaveLength(0);

    const rows = buildRows(buildRenderTree(ir, nodes));
    expect(rows.find((r) => r.irNode.id === "fanout_parallel_loop_switch")?.label).toContain("×3");
    expect(rows.filter((r) => r.groupDim === "lane").map((r) => r.label)).toEqual([
      "lane=0 «alpha»",
      "lane=1 «beta»",
      "lane=2 «gamma»"
    ]);
    expect(rows.filter((r) => r.groupDim === "round")).toHaveLength(9);
  }, 120_000);

  it("can force the switch default branch through explicit input", async () => {
    const home = makeIsolatedHome();
    const source = patchWorkflowSource(home);
    const compiled = compileWorkflow(source, { sourcePath: fixturePath });
    expect(compiled.ok).toBe(true);
    const ir = compiled.ir!;

    const { interpreter, store, cleanup } = createTestInterpreter({ useRealAgentExecutor: true });
    cleanups.push(cleanup);

    const meta = await interpreter.start(ir, { input: { route_mode: "fallback" } });
    expect(meta.status).toBe("completed");
    const nodes = store.listNodeStates(meta.runId);
    expect(nodes.filter((n) => n.nodeId === "switch_alpha_agent")).toHaveLength(1);
    expect(nodes.filter((n) => n.nodeId === "switch_default_agent")).toHaveLength(0);
    expect(nodes.filter((n) => n.nodeId === "switch_fallback_agent")).toHaveLength(2);
  }, 120_000);
});
