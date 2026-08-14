export type AppView =
  | { page: "runs"; workspaceKey?: string }
  | { page: "run-monitor"; workspaceKey?: string; runId: string }
  | { page: "workflows" };

const ownedSearchParams = ["view", "workspace", "run"] as const;

export function appViewFromUrl(url: URL): AppView {
  const runId = nonBlank(url.searchParams.get("run"));
  const workspaceKey = nonBlank(url.searchParams.get("workspace"));
  if (runId) {
    return {
      page: "run-monitor",
      runId,
      ...(workspaceKey ? { workspaceKey } : {}),
    };
  }
  if (url.searchParams.get("view") === "workflows") return { page: "workflows" };
  return { page: "runs", ...(workspaceKey ? { workspaceKey } : {}) };
}

export function urlForAppView(currentUrl: URL, view: AppView, currentWorkspaceKey: string | undefined): URL {
  const url = new URL(currentUrl);
  for (const name of ownedSearchParams) url.searchParams.delete(name);

  if (view.page === "workflows") {
    url.searchParams.set("view", "workflows");
    return url;
  }

  if (view.workspaceKey && view.workspaceKey !== currentWorkspaceKey) {
    url.searchParams.set("workspace", view.workspaceKey);
  }
  if (view.page === "run-monitor") url.searchParams.set("run", view.runId);
  return url;
}

function nonBlank(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
