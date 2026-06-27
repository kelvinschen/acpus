import { describe, it, expect } from "vitest";
import { HookRunner, HookFailureError } from "../../src/hooks/runner.js";
import type { AgentInjectorResult, HookConfig, HookPayload, ProgramInjectorResult } from "@acpus/core";

function payload(name: string): HookPayload {
  return {
    hook_event_name: name,
    run_id: "r1",
    workflow_name: "wf",
    workflow_source_path: "/tmp/wf.yaml",
    workflow_source_dir: "/tmp",
    cwd: process.cwd(),
    timestamp: new Date().toISOString()
  };
}

describe("HookRunner injectors", () => {
  it("concatenates prependPrompt across handlers in order", async () => {
    const config: HookConfig = {
      injectors: {
        beforeAgentExec: [
          { command: `printf '{"prependPrompt":"first"}'` },
          { command: `printf '{"prependPrompt":"second"}'` }
        ]
      }
    };
    const result = await new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")) as AgentInjectorResult;
    expect(result.prependPrompt).toBe("first\nsecond");
  });

  it("merges env with later handlers overriding earlier for beforeProgramExec", async () => {
    const config: HookConfig = {
      injectors: {
        beforeProgramExec: [
          { command: `printf '{"env":{"A":"1","B":"1"}}'` },
          { command: `printf '{"env":{"B":"2"}}'` }
        ]
      }
    };
    const result = await new HookRunner(config).runInjector("beforeProgramExec", payload("beforeProgramExec")) as ProgramInjectorResult;
    expect(result.env).toEqual({ A: "1", B: "2" });
  });

  it("passes the payload to the handler on stdin", async () => {
    const config: HookConfig = {
      injectors: {
        beforeAgentExec: [
          // Echo back the run_id read from stdin as prependPrompt.
          { command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({prependPrompt:p.run_id}))})'` }
        ]
      }
    };
    const result = await new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")) as AgentInjectorResult;
    expect(result.prependPrompt).toBe("r1");
  });

  it("fails the node (throws) on non-zero exit under default on_failure fail", async () => {
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: "echo boom >&2; exit 3" }] }
    };
    await expect(new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")))
      .rejects.toBeInstanceOf(HookFailureError);
  });

  it("skips and continues on non-zero exit under on_failure skip", async () => {
    const config: HookConfig = {
      injectors: {
        beforeAgentExec: [
          { command: "exit 1", on_failure: "skip" },
          { command: `printf '{"prependPrompt":"ok"}'` }
        ]
      }
    };
    const result = await new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")) as AgentInjectorResult;
    expect(result.prependPrompt).toBe("ok");
  });

  it("treats invalid JSON stdout as a failure", async () => {
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: "echo not-json" }] }
    };
    await expect(new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")))
      .rejects.toBeInstanceOf(HookFailureError);
  });

  it("treats a timeout as a failure under fail policy", async () => {
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: "sleep 2", timeout: "50ms" }] }
    };
    await expect(new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")))
      .rejects.toBeInstanceOf(HookFailureError);
  });

  it("empty stdout injects nothing and does not fail", async () => {
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: "true" }] }
    };
    const result = await new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec")) as AgentInjectorResult;
    expect(result.prependPrompt).toBeUndefined();
  });

  it("journals each handler via the callback", async () => {
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: `printf '{"prependPrompt":"x"}'` }] }
    };
    const calls: Array<{ index: number; ctx?: string }> = [];
    await new HookRunner(config).runInjector("beforeAgentExec", payload("beforeAgentExec"), (i, r) => {
      calls.push({ index: i, ctx: (r as AgentInjectorResult).prependPrompt });
    });
    expect(calls).toEqual([{ index: 0, ctx: "x" }]);
  });
});

describe("HookRunner events", () => {
  it("never throws on a failing event handler", async () => {
    const config: HookConfig = {
      events: { afterRun: [{ command: "exit 1" }] }
    };
    await expect(new HookRunner(config).emitEvent("afterRun", payload("afterRun"))).resolves.toBeUndefined();
  });

  it("does not block on default async event handlers", async () => {
    const config: HookConfig = {
      events: { afterRun: [{ command: "sleep 1" }] }
    };
    const start = Date.now();
    await new HookRunner(config).emitEvent("afterRun", payload("afterRun"));
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("awaits sync event handlers", async () => {
    const config: HookConfig = {
      events: { afterRun: [{ command: "sleep 0.1", sync: true }] }
    };
    const start = Date.now();
    await new HookRunner(config).emitEvent("afterRun", payload("afterRun"));
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it("hasInjector / hasEvent reflect configuration", () => {
    const runner = new HookRunner({ injectors: { beforeAgentExec: [{ command: "x" }] } });
    expect(runner.hasInjector("beforeAgentExec")).toBe(true);
    expect(runner.hasInjector("beforeProgramExec")).toBe(false);
    expect(runner.hasEvent("afterRun")).toBe(false);
  });
});
