import type { Context } from "@deepseek-ai/cordis";
import { registerSupervisorTools } from "./host/tools.js";

export const name = "acpus-supervisor";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  registerSupervisorTools(ctx);
}
