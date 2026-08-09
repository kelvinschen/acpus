import type { ComponentType, SVGProps } from "react";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import GitFork from "lucide-react/dist/esm/icons/git-fork.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import Repeat from "lucide-react/dist/esm/icons/repeat.js";
import Rows3 from "lucide-react/dist/esm/icons/rows-3.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Split from "lucide-react/dist/esm/icons/split.js";
import Terminal from "lucide-react/dist/esm/icons/terminal.js";

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
}>;

const kindIcons: Record<string, LucideIcon> = {
  task: Terminal,
  agent: Bot,
  signal: Radio,
  assert: ShieldCheck,
  if: GitFork,
  switch: GitBranch,
  parallel: Rows3,
  fanout: Split,
  loop: Repeat,
};

export function NodeKindIcon({ kind, size }: { kind: string; size: number }) {
  const Icon = kindIcons[kind] ?? Terminal;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

export function NodeKindBadge({ kind }: { kind: string }) {
  return (
    <span className={`type-badge node-kind-badge ${kind}`}>
      <NodeKindIcon kind={kind} size={12} />
      {kind.toUpperCase()}
    </span>
  );
}
