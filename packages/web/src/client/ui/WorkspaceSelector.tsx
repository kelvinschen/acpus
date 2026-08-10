import { useMemo, useState } from "react";
import type { WorkspaceCatalog, WorkspaceSummary } from "../api.js";
import { formatDate } from "./display-format.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./shadcn/select.js";

export function WorkspaceSelector({
  catalog,
  selectedWorkspaceKey,
  now,
  onSelect,
}: {
  catalog: WorkspaceCatalog;
  selectedWorkspaceKey: string;
  now: number;
  onSelect(workspaceKey: string): void;
}) {
  const sorted = useMemo(
    () => sortWorkspaces(catalog.workspaces, catalog.currentWorkspaceKey),
    [catalog.currentWorkspaceKey, catalog.workspaces],
  );
  const [frozen, setFrozen] = useState<WorkspaceSummary[] | undefined>();
  const visible = frozen ?? sorted;
  const selected = catalog.workspaces.find(workspace => workspace.key === selectedWorkspaceKey);

  if (!selected) return null;
  const current = selected.key === catalog.currentWorkspaceKey;
  const metadata = workspaceMetadata(selected, now);
  const absoluteUpdatedAt = selected.lastRunUpdatedAt
    ? formatDate(selected.lastRunUpdatedAt)
    : selected.runCount === 0 ? "No runs" : "Unavailable";
  const title = `${selected.path}\n${metadata}\nLast updated: ${absoluteUpdatedAt}`;

  return (
    <label className="workspace-select-wrap">
      <span className="workspace-select-label">Workspace</span>
      <Select
        value={selectedWorkspaceKey}
        onValueChange={onSelect}
        onOpenChange={open => setFrozen(open ? sorted : undefined)}
      >
        <SelectTrigger
          className="workspace-select"
          aria-label={`Workspace: ${selected.name}, ${current ? "current" : "read only"}, ${metadata}, last updated ${absoluteUpdatedAt}, ${selected.path}`}
          title={title}
        >
          <SelectValue>
            <span className="workspace-select-value">
              <span className="workspace-select-value-main">
                <strong>{selected.name}</strong>
                <span className={`workspace-scope-badge ${current ? "current" : "read-only"}`}>
                  {current ? "Current" : "Read only"}
                </span>
              </span>
              <span className="workspace-select-meta">{metadata}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="workspace-select-content">
          {visible.map(workspace => {
            const isCurrent = workspace.key === catalog.currentWorkspaceKey;
            const optionMetadata = workspaceMetadata(workspace, now);
            const optionTitle = `${workspace.path}\n${optionMetadata}${workspace.lastRunUpdatedAt ? `\nLast updated: ${formatDate(workspace.lastRunUpdatedAt)}` : ""}`;
            return (
              <SelectItem
                key={workspace.key}
                value={workspace.key}
                aria-label={`${workspace.name}, ${isCurrent ? "current" : "read only"}, ${workspace.path}, ${optionMetadata}, last updated ${workspace.lastRunUpdatedAt ? formatDate(workspace.lastRunUpdatedAt) : workspace.runCount === 0 ? "no runs" : "unavailable"}`}
                title={optionTitle}
              >
                <span className="workspace-select-option">
                  <span className="workspace-select-option-title">
                    <strong>{workspace.name}</strong>
                    {isCurrent && <span className="workspace-scope-badge current">Current</span>}
                  </span>
                  <span className="workspace-select-option-path">{compactWorkspacePath(workspace.path)}</span>
                  <span className="workspace-select-option-meta">{optionMetadata}</span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

export function sortWorkspaces(
  workspaces: readonly WorkspaceSummary[],
  currentWorkspaceKey: string,
): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) => {
    if (left.key === currentWorkspaceKey) return right.key === currentWorkspaceKey ? 0 : -1;
    if (right.key === currentWorkspaceKey) return 1;
    const leftUpdatedAt = workspaceTimestamp(left.lastRunUpdatedAt);
    const rightUpdatedAt = workspaceTimestamp(right.lastRunUpdatedAt);
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
    return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
  });
}

function workspaceTimestamp(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function workspaceMetadata(workspace: WorkspaceSummary, now: number): string {
  const count = workspace.runCount === undefined
    ? "Run count unavailable"
    : `${workspace.runCount} ${workspace.runCount === 1 ? "run" : "runs"}`;
  if (!workspace.lastRunUpdatedAt) return count;
  const timestamp = Date.parse(workspace.lastRunUpdatedAt);
  if (!Number.isFinite(timestamp)) return `${count} · Updated ${workspace.lastRunUpdatedAt}`;
  const age = formatWorkspaceAge(Math.max(0, now - timestamp));
  return `${count} · Updated ${age} ago`;
}

function formatWorkspaceAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function compactWorkspacePath(path: string): string {
  if (path.length <= 48) return path;
  const segments = path.split(/[\\/]/).filter(Boolean);
  const tail = segments.slice(-3).join("/");
  return tail.length < path.length ? `…/${tail}` : path;
}
