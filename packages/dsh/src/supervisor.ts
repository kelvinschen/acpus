import type { Context } from "@deepseek-ai/cordis";
import type { AcpusMode } from "./host/mode.js";
import { renderAgentCatalog } from "./host/agent-profiles.js";
import { registerSupervisorTools } from "./host/tools.js";

export const name = "acpus-supervisor";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx: Context): void {
  registerSupervisorTools(ctx);
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const service = ctx.get("acpusMode") as AcpusMode | undefined;
    if (service === undefined) {
      throw new Error("Acpus mode Host service is unavailable.");
    }
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        acpus_agents: renderAgentCatalog(await service.agentProfiles()),
      },
    };
  });
}
