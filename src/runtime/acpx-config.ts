import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AcpxConfigLoadOptions = {
  homeDir?: string;
  projectConfigPath?: string;
};

export async function loadAcpxAgentOverrides(cwd: string, options: AcpxConfigLoadOptions = {}): Promise<Record<string, string> | undefined> {
  const globalPath = path.join(options.homeDir ?? os.homedir(), ".acpx", "config.json");
  const projectPath = options.projectConfigPath ?? path.join(path.resolve(cwd), ".acpxrc.json");
  const [globalConfig, projectConfig] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath)
  ]);
  const merged = {
    ...parseAgentOverrides(globalConfig, globalPath),
    ...parseAgentOverrides(projectConfig, projectPath)
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function parseAgentOverrides(config: unknown, sourcePath = "acpx config"): Record<string, string> | undefined {
  if (config == null) return undefined;
  const record = asRecord(config);
  if (!record) throw new Error(`Invalid config in ${sourcePath}: expected top-level JSON object`);
  if (record.agents == null) return undefined;
  const agents = asRecord(record.agents);
  if (!agents) throw new Error(`Invalid config agents in ${sourcePath}: expected object`);
  const parsed: Record<string, string> = {};
  for (const [name, rawAgent] of Object.entries(agents)) {
    const agent = asRecord(rawAgent);
    if (!agent) throw new Error(`Invalid config agents.${name} in ${sourcePath}: expected object with command`);
    const command = agent.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(`Invalid config agents.${name}.command in ${sourcePath}: expected non-empty string`);
    }
    const args = parseAgentArgs(agent.args, name, sourcePath);
    parsed[normalizeAgentName(name)] = args.length > 0 ? `${command.trim()} ${args.map(quoteCommandArg).join(" ")}` : command.trim();
  }
  return parsed;
}

async function readConfigFile(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseAgentArgs(value: unknown, agentName: string, sourcePath: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid config agents.${agentName}.args in ${sourcePath}: expected array of strings`);
  return value.map((arg, index) => {
    if (typeof arg !== "string") throw new Error(`Invalid config agents.${agentName}.args[${index}] in ${sourcePath}: expected string`);
    return arg;
  });
}

function quoteCommandArg(value: string): string {
  return JSON.stringify(value);
}

function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
