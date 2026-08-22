import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Inbox } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AcpusMode from "@acpus/dsh";
import * as Supervisor from "@acpus/dsh/supervisor";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export async function loadDshComposition(config: {
  dshHome: string;
  stateDir: string;
}): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const modules = new Map<string, unknown>([
    ["@deepseek-ai/dsh-system-prompt", SystemPrompt],
    ["@deepseek-ai/dsh-tools", ToolRuntime],
    ["@acpus/dsh", AcpusMode],
    ["@acpus/dsh/supervisor", Supervisor],
  ]);
  ctx.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected DSH Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: "@deepseek-ai/dsh-system-prompt" });
  await ctx.loader.create({ name: "@deepseek-ai/dsh-tools" });
  await ctx.loader.create({ name: "@acpus/dsh", config });
  await ctx.loader.create({ name: "@acpus/dsh/supervisor" });
  await ctx.loader.await();
  return ctx;
}

export function supervisingAgent(ctx: Context, cwd: string): Agent {
  const id = SessionId("acpus-supervisor-session");
  const scope = ctx.plugin(() => {});
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd });
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, {
      inserted() {},
      discarded() {},
      claimed() {},
    }),
    status: "idle",
    ctx: scope.ctx,
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  };
}

export async function terminalRun(
  runtime: Awaited<ReturnType<AcpusMode["runtime"]>>,
  runId: string,
): Promise<{ run: { status: string }; output?: unknown }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await Effect.runPromise(Effect.result(runtime.inspect({ kind: "run", runId })));
    if (Result.isFailure(result)) throw new Error(result.failure.message);
    if (result.success.kind !== "run") throw new Error("Expected a run view.");
    if (result.success.run.status === "completed"
      || result.success.run.status === "failed"
      || result.success.run.status === "canceled") {
      return result.success;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Acpus run did not reach terminal state before the test deadline.");
}
