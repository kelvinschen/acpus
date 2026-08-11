export type TerminalTreeEdge = "node" | "region";

export function terminalTreeConnector(edge: TerminalTreeEdge, last: boolean, firstRoot = false): string {
  if (firstRoot) return "┌─";
  if (edge === "region") return last ? "└┄" : "├┄";
  return last ? "└─" : "├─";
}

export function terminalTreeChildPrefix(prefix: string, last: boolean): string {
  return `${prefix}${last ? "   " : "│  "}`;
}
