import { sha256Digest, type Sha256Digest } from "@acpus/core/content-identity";
import type { SchemaIR } from "@acpus/core/ir";
import {
  buildAgentOutputPrompt,
  buildAgentOutputRepairPrompt,
} from "./agent-output.js";

export type AgentPromptOrigin = "authored" | "steering" | "repair";
export type AgentOutputFailurePhase = "framing" | "json" | "schema";

const AGENT_PROMPT_DOMAIN = "acpus:agent-prompt:v1\0";

export type BuiltAgentPrompt = Readonly<{
  prompt: string;
  promptOrigin: AgentPromptOrigin;
  inputDigest: Sha256Digest;
}>;

export function buildAuthoredAgentPrompt(renderedPrompt: string, outputSchema?: SchemaIR): BuiltAgentPrompt {
  return built("authored", outputSchema === undefined
    ? renderedPrompt
    : buildAgentOutputPrompt(renderedPrompt, outputSchema));
}

export function buildSteeringAgentPrompt(instruction: string, outputSchema?: SchemaIR): BuiltAgentPrompt {
  const prompt = `<steering>${instruction}</steering>`;
  return built("steering", outputSchema === undefined ? prompt : buildAgentOutputPrompt(prompt, outputSchema));
}

export function buildRepairAgentPrompt(schema: SchemaIR, phase: AgentOutputFailurePhase): BuiltAgentPrompt {
  return built("repair", buildAgentOutputRepairPrompt(schema, phase));
}

export function agentPromptInputDigest(prompt: string): Sha256Digest {
  return sha256Digest(`${AGENT_PROMPT_DOMAIN}${prompt}`);
}

function built(promptOrigin: AgentPromptOrigin, prompt: string): BuiltAgentPrompt {
  return { prompt, promptOrigin, inputDigest: agentPromptInputDigest(prompt) };
}
