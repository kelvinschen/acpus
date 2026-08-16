import claude from "../../agent-icons/claude.svg";
import codex from "../../agent-icons/codex.svg";
import copilot from "../../agent-icons/copilot.svg";
import cursor from "../../agent-icons/cursor.svg";
import dsh from "../../agent-icons/dsh.svg";
import kimi from "../../agent-icons/kimi.svg";
import opencode from "../../agent-icons/opencode.svg";
import pi from "../../agent-icons/pi.svg";
import trae from "../../agent-icons/trae.svg";
import universal from "../../agent-icons/universal.svg";

const ICONS: Readonly<Record<string, string>> = {
  claude,
  codex,
  copilot,
  cursor,
  dsh,
  kimi,
  opencode,
  pi,
  trae,
};

export function agentIcon(name: string | undefined): {
  source: string;
  known: boolean;
  name: string;
} {
  const normalized = name?.toLowerCase() ?? "agent";
  const source = ICONS[normalized];
  return source === undefined
    ? { source: universal, known: false, name: name ?? "Agent" }
    : { source, known: true, name: name ?? normalized };
}
