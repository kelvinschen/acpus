import * as React from "react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Boxes from "lucide-react/dist/esm/icons/boxes.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Folder from "lucide-react/dist/esm/icons/folder.js";
import Package from "lucide-react/dist/esm/icons/package.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import {
  listWorkflowCatalog,
  listWorkflowFiles,
  visualizeWorkflow,
  type ProjectWorkflowCatalogEntry,
  type WorkflowFileEntry,
  type WorkflowVisualizationResult,
  type WorkflowVisualizationSource,
} from "../api.js";
import { StateBlock } from "./Inspector.js";
import { StaticGraphApp } from "./StaticGraphApp.js";
import { Badge } from "./shadcn/badge.js";
import { Button } from "./shadcn/button.js";
import {
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "./shadcn/breadcrumb.js";
import { Input } from "./shadcn/input.js";
import { List, ListRow } from "./shadcn/list.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./shadcn/tabs.js";

export function WorkflowsPage() {
  const [dir, setDir] = useState("");
  const [source, setSource] = useState<WorkflowVisualizationSource | undefined>();
  const [result, setResult] = useState<WorkflowVisualizationResult | undefined>();
  const catalog = useQuery({
    queryKey: ["workflow-catalog"],
    queryFn: listWorkflowCatalog,
  });
  const files = useQuery({
    queryKey: ["workflow-files", dir],
    queryFn: () => listWorkflowFiles(dir),
  });
  const visualize = useMutation({
    mutationFn: (next: WorkflowVisualizationSource) => visualizeWorkflow(next),
    onSuccess: next => {
      setResult(next);
    },
  });

  const graph = result?.status === "ready" ? result.graph : undefined;

  return (
    <div className="workflow-viz-grid">
      <section className="table-panel workflow-source-panel">
        <PageHeader title="Workflows" detail="Static Visualization" />
        <WorkflowSourcePicker
          catalog={catalog.data ?? []}
          catalogLoading={catalog.isLoading}
          catalogError={catalog.error}
          files={files.data?.entries ?? []}
          filesLoading={files.isLoading}
          filesError={files.error}
          dir={files.data?.dir ?? dir}
          selected={source}
          visualizing={visualize.isPending}
          visualizeError={visualize.error}
          visualizationFailure={result?.status === "failed" ? result : undefined}
          onOpenDir={setDir}
          onSelect={next => {
            setSource(next);
            setResult(undefined);
          }}
          onVisualize={() => source && visualize.mutate(source)}
        />
      </section>
      {graph && result?.status === "ready" ? (
        <StaticGraphApp data={result} />
      ) : (
        <section className="graph-panel">
          <EmptyState title="No Workflow Visualized" detail="Choose a catalog entry or workspace workflow file, then click Visualize." />
        </section>
      )}
    </div>
  );
}
function WorkflowSourcePicker({
  catalog,
  catalogLoading,
  catalogError,
  files,
  filesLoading,
  filesError,
  dir,
  selected,
  visualizing,
  visualizeError,
  visualizationFailure,
  onOpenDir,
  onSelect,
  onVisualize,
}: {
  catalog: ProjectWorkflowCatalogEntry[];
  catalogLoading: boolean;
  catalogError: unknown;
  files: WorkflowFileEntry[];
  filesLoading: boolean;
  filesError: unknown;
  dir: string;
  selected: WorkflowVisualizationSource | undefined;
  visualizing: boolean;
  visualizeError: unknown;
  visualizationFailure: Extract<WorkflowVisualizationResult, { status: "failed" }> | undefined;
  onOpenDir(dir: string): void;
  onSelect(source: WorkflowVisualizationSource): void;
  onVisualize(): void;
}) {
  const [activeTab, setActiveTab] = useState<"catalog" | "files">("catalog");
  const selectedSummary = describeWorkflowSource(selected);
  return (
    <div className="workflow-picker">
      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as "catalog" | "files")} className="workflow-picker-tabs">
        <TabsList className="workflow-picker-tabs-list" aria-label="Workflow source type">
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="workflow-picker-tab-panel">
          <WorkflowCatalogList
            entries={catalog}
            loading={catalogLoading}
            error={catalogError}
            selected={selected}
            onSelect={onSelect}
          />
        </TabsContent>
        <TabsContent value="files" className="workflow-picker-tab-panel">
          <WorkflowFileSelector
            entries={files}
            loading={filesLoading}
            error={filesError}
            dir={dir}
            selected={selected}
            onOpenDir={onOpenDir}
            onSelect={onSelect}
          />
        </TabsContent>
      </Tabs>
      <div className="workflow-picker-footer">
        <div className={`workflow-selected-source ${selected ? "selected" : ""}`}>
          <span>Selected source</span>
          <strong>{selectedSummary.title}</strong>
          {selectedSummary.detail && <small>{selectedSummary.detail}</small>}
        </div>
        <Button
          variant="default"
          className="primary-button"
          disabled={!selected || visualizing}
          onClick={onVisualize}
        >
          {visualizing ? "Visualizing..." : "Visualize"}
        </Button>
        {visualizeError ? (
          <StateBlock
            tone="error"
            title="Visualization failed"
            detail={visualizeError instanceof Error ? visualizeError.message : String(visualizeError)}
          />
        ) : null}
        {visualizationFailure && (
          <StateBlock tone="error" title={`${visualizationFailure.phase} failed`} detail={visualizationFailure.message} />
        )}
      </div>
    </div>
  );
}

function WorkflowCatalogList({
  entries,
  loading,
  error,
  selected,
  onSelect,
}: {
  entries: ProjectWorkflowCatalogEntry[];
  loading: boolean;
  error: unknown;
  selected: WorkflowVisualizationSource | undefined;
  onSelect(source: WorkflowVisualizationSource): void;
}) {
  if (loading) return <StateBlock tone="loading" title="Loading catalog" />;
  if (error) return <StateBlock tone="error" title="Catalog unavailable" detail={error instanceof Error ? error.message : String(error)} />;
  if (entries.length === 0) {
    return <StateBlock tone="empty" title="No catalog workflows" detail="Use Files to choose a workflow module from this workspace." />;
  }
  return (
    <List className="workflow-source-table" role="group" aria-label="Project catalog workflows">
      {entries.map(entry => {
        const active = selected?.kind === "catalog" && selected.name === entry.name;
        return (
          <ListRow
            key={entry.name}
            className={`workflow-list-row catalog ${active ? "selected" : ""}`}
            aria-pressed={active}
            onClick={() => onSelect({ kind: "catalog", name: entry.name })}
          >
            <Package size={15} />
            <span className="workflow-row-main">
              <strong>{entry.name}</strong>
              <small>{compactWorkflowPath(entry.entryPath)}</small>
            </span>
            <Badge className="workflow-row-badge">project</Badge>
          </ListRow>
        );
      })}
    </List>
  );
}

function WorkflowFileSelector({
  entries,
  loading,
  error,
  dir,
  selected,
  onOpenDir,
  onSelect,
}: {
  entries: WorkflowFileEntry[];
  loading: boolean;
  error: unknown;
  dir: string;
  selected: WorkflowVisualizationSource | undefined;
  onOpenDir(dir: string): void;
  onSelect(source: WorkflowVisualizationSource): void;
}) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleEntries = normalizedFilter
    ? entries.filter(entry => `${entry.name} ${entry.path}`.toLowerCase().includes(normalizedFilter))
    : entries;

  return (
    <div className="workflow-file-selector">
      <div className="workflow-file-toolbar">
        <WorkflowBreadcrumb dir={dir} onOpenDir={onOpenDir} />
        <label className="workflow-filter">
          <Search size={14} aria-hidden="true" />
          <Input
            value={filter}
            onChange={event => setFilter(event.currentTarget.value)}
            placeholder="Filter current directory"
            aria-label="Filter current directory"
          />
        </label>
      </div>
      {loading ? (
        <StateBlock tone="loading" title="Loading workspace files" />
      ) : error ? (
        <StateBlock tone="error" title="Files unavailable" detail={error instanceof Error ? error.message : String(error)} />
      ) : visibleEntries.length === 0 ? (
        <StateBlock tone="empty" title="No workflow files here" detail={filter ? "Clear the filter or open another directory." : "Open a directory that contains .workflow.ts or .workflow.tsx files."} />
      ) : (
        <List className="workflow-source-table" role="group" aria-label="Workspace workflow files">
          {visibleEntries.map(entry => {
            const active = selected?.kind === "file" && selected.path === entry.path;
            const directory = entry.kind === "directory";
            return (
              <ListRow
                key={`${entry.kind}:${entry.path}`}
                className={`workflow-list-row file ${directory ? "directory" : "workflow"} ${active ? "selected" : ""}`}
                aria-pressed={active}
                onClick={() => directory ? onOpenDir(entry.path) : onSelect({ kind: "file", path: entry.path })}
              >
                {directory ? <Folder size={15} /> : <FileText size={15} />}
                <span className="workflow-row-main">
                  <strong>{entry.name}</strong>
                  <small>{entry.path}</small>
                </span>
                <Badge className="workflow-row-badge">{directory ? "directory" : "workflow"}</Badge>
                {directory && <ChevronRight size={14} className="workflow-row-chevron" aria-hidden="true" />}
              </ListRow>
            );
          })}
        </List>
      )}
    </div>
  );
}

function WorkflowBreadcrumb({ dir, onOpenDir }: { dir: string; onOpenDir(dir: string): void }) {
  const segments = dir.split("/").filter(Boolean);
  const targets = segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
  return (
    <Breadcrumb aria-label="Workspace path" className="workflow-breadcrumb">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbButton
            aria-current={dir.length === 0 ? "page" : undefined}
            onClick={() => onOpenDir("")}
          >
            Workspace
          </BreadcrumbButton>
        </BreadcrumbItem>
        {segments.map((segment, index) => {
          const target = targets[index]!;
          return (
            <React.Fragment key={target}>
              <BreadcrumbSeparator><ChevronRight size={13} /></BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbButton
                  aria-current={target === dir ? "page" : undefined}
                  onClick={() => onOpenDir(target)}
                >
                  {segment}
                </BreadcrumbButton>
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function describeWorkflowSource(source: WorkflowVisualizationSource | undefined): { title: string; detail?: string } {
  if (!source) return { title: "None selected", detail: "Choose from Catalog or Files." };
  if (source.kind === "catalog") return { title: source.name, detail: "Project catalog entry" };
  return { title: fileNameFromPath(source.path), detail: source.path };
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function compactWorkflowPath(path: string): string {
  const workflowMarker = "/.acpus/workflows/";
  const workflowIndex = path.indexOf(workflowMarker);
  if (workflowIndex >= 0) return `.acpus/workflows/${path.slice(workflowIndex + workflowMarker.length)}`;
  const packageMarker = "/packages/";
  const packageIndex = path.indexOf(packageMarker);
  if (packageIndex >= 0) return `packages/${path.slice(packageIndex + packageMarker.length)}`;
  return path;
}

function PageHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <header className="page-header">
      <h2>{title}</h2>
      <span className="page-header-detail">{detail}</span>
    </header>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Boxes size={22} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
