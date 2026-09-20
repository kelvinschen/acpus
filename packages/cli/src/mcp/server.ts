import { McpServer } from "@modelcontextprotocol/server";
import { getCliPackageInfo } from "../platform/package-info.js";
import { acpusInstructions, registerTools, type RunTool } from "./tools.js";

export function createMcpServer(run: RunTool): McpServer {
  const server = new McpServer({ name: "acpus", version: getCliPackageInfo().version }, { instructions: acpusInstructions });
  registerTools(server, run);
  return server;
}
