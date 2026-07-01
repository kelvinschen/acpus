import ts from "typescript";
import { execFunction, isTaskDefineCall, objectProperty, parseSourceFile, taskFactoryLocalName } from "./ast.js";
import { findTaskCallsites } from "./callsites.js";
import { collectFreeIdentifiers } from "./inline-capture.js";
import { resolveImportFile, resolveImportFileSync, verifyTaskModuleExport, verifyTaskModuleExportSync } from "./module-exports.js";
import type { ImportBinding, TaskAuthoringIssue, TaskBundleMetadata, TaskCallsite, WorkflowTaskExport } from "./types.js";
import { collectImportBindings, collectLocalValueNames, collectWorkflowTaskExports, hasInnerBinding } from "./workflow-symbols.js";

// Static task analysis parses workflow modules and task modules with the
// TypeScript parser only. It produces facts and bundle metadata, not
// diagnostics. Authoring rules own rule codes, messages, and hints; compile
// and bundling consume only metadata.

export type {
  AnalyzedTask,
  TaskAnalysisFact,
  TaskAuthoringIssue,
  TaskBundleMetadata,
  TaskMetadataFact,
  WorkflowTaskAnalysis,
} from "./types.js";

import type { AnalyzedTask, TaskAnalysisFact, WorkflowTaskAnalysis } from "./types.js";

type AnalyzeContext = {
  workflowFile: string;
  imports: Map<string, ImportBinding>;
  locals: Set<string>;
  localExports: Map<string, WorkflowTaskExport>;
};

export async function analyzeWorkflowTasks(workflowFile: string, source: string): Promise<WorkflowTaskAnalysis> {
  const sourceFile = parseSourceFile(workflowFile, source);
  const imports = collectImportBindings(sourceFile);
  const locals = collectLocalValueNames(sourceFile);
  const localExports = collectWorkflowTaskExports(sourceFile);
  const analysis: WorkflowTaskAnalysis = new Map();
  for (const callsite of findTaskCallsites(sourceFile)) {
    setAnalyzedCallsite(analysis, callsite, await analyzeCallsite(callsite, { workflowFile, imports, locals, localExports }));
  }
  return analysis;
}

export function analyzeWorkflowTasksSync(workflowFile: string, source: string): WorkflowTaskAnalysis {
  const sourceFile = parseSourceFile(workflowFile, source);
  const imports = collectImportBindings(sourceFile);
  const locals = collectLocalValueNames(sourceFile);
  const localExports = collectWorkflowTaskExports(sourceFile);
  const analysis: WorkflowTaskAnalysis = new Map();
  for (const callsite of findTaskCallsites(sourceFile)) {
    setAnalyzedCallsite(analysis, callsite, analyzeCallsiteSync(callsite, { workflowFile, imports, locals, localExports }));
  }
  return analysis;
}

export function analyzeTaskAuthoring(analysis: WorkflowTaskAnalysis): TaskAnalysisFact[] {
  return [...analysis].map(([stepId, analyzed]) => ({
    stepId,
    inline: analyzed.inline,
    ...(analyzed.issue ? { issue: analyzed.issue } : {}),
    ...(analyzed.source ? { source: analyzed.source } : {}),
  }));
}

export function resolveTaskBundleMetadata(analysis: WorkflowTaskAnalysis): Map<string, TaskBundleMetadata> {
  const metadata = new Map<string, TaskBundleMetadata>();
  for (const [stepId, analyzed] of analysis) {
    if (analyzed.metadata) metadata.set(stepId, analyzed.metadata);
  }
  return metadata;
}

async function analyzeCallsite(callsite: TaskCallsite, ctx: AnalyzeContext): Promise<AnalyzedTask> {
  const run = objectProperty(callsite.options, "run");
  const taskValue = run && ts.isObjectLiteralExpression(run) ? objectProperty(run, "task") : undefined;
  if (taskValue) return withIssueSource(await analyzeReusable(taskValue, ctx), callsite);
  const exec = execFunction(callsite.options);
  if (exec) return withIssueSource(analyzeInline(exec), callsite);
  return { inline: true };
}

function analyzeCallsiteSync(callsite: TaskCallsite, ctx: AnalyzeContext): AnalyzedTask {
  const run = objectProperty(callsite.options, "run");
  const taskValue = run && ts.isObjectLiteralExpression(run) ? objectProperty(run, "task") : undefined;
  if (taskValue) return withIssueSource(analyzeReusableSync(taskValue, ctx), callsite);
  const exec = execFunction(callsite.options);
  if (exec) return withIssueSource(analyzeInline(exec), callsite);
  return { inline: true };
}

async function analyzeReusable(taskValue: ts.Expression, ctx: AnalyzeContext): Promise<AnalyzedTask> {
  if (!ts.isIdentifier(taskValue)) {
    return reusableIssue({ kind: "invalid-reusable-task-reference" });
  }
  const local = analyzeLocalReusable(taskValue, ctx);
  if (local) return local;
  const name = taskValue.text;
  const binding = ctx.imports.get(name);
  if (!binding) {
    return reusableIssue({ kind: "invalid-reusable-task-reference", name });
  }
  if (!binding.specifier.startsWith(".")) {
    return reusableIssue({ kind: "unsupported-task-import", name, specifier: binding.specifier, reason: "third-party" });
  }
  const targetFile = await resolveImportFile(binding.specifier, ctx.workflowFile);
  if (!targetFile) {
    return reusableIssue({ kind: "unsupported-task-import", name, specifier: binding.specifier, reason: "unresolved" });
  }
  const verdict = await verifyTaskModuleExport(targetFile, binding.importedName);
  if (!verdict.ok) return reusableIssue(verdict.issue);
  return reusableMetadata(targetFile, binding.importedName, "task-module");
}

function analyzeReusableSync(taskValue: ts.Expression, ctx: AnalyzeContext): AnalyzedTask {
  if (!ts.isIdentifier(taskValue)) {
    return reusableIssue({ kind: "invalid-reusable-task-reference" });
  }
  const local = analyzeLocalReusable(taskValue, ctx);
  if (local) return local;
  const name = taskValue.text;
  const binding = ctx.imports.get(name);
  if (!binding) {
    return reusableIssue({ kind: "invalid-reusable-task-reference", name });
  }
  if (!binding.specifier.startsWith(".")) {
    return reusableIssue({ kind: "unsupported-task-import", name, specifier: binding.specifier, reason: "third-party" });
  }
  const targetFile = resolveImportFileSync(binding.specifier, ctx.workflowFile);
  if (!targetFile) {
    return reusableIssue({ kind: "unsupported-task-import", name, specifier: binding.specifier, reason: "unresolved" });
  }
  const verdict = verifyTaskModuleExportSync(targetFile, binding.importedName);
  if (!verdict.ok) return reusableIssue(verdict.issue);
  return reusableMetadata(targetFile, binding.importedName, "task-module");
}

function analyzeLocalReusable(taskValue: ts.Identifier, ctx: AnalyzeContext): AnalyzedTask | undefined {
  const name = taskValue.text;
  if (hasInnerBinding(taskValue)) {
    return reusableIssue({ kind: "workflow-local-reusable-task", name });
  }
  const localExport = ctx.localExports.get(name);
  if (localExport) {
    const taskFactory = taskFactoryLocalName(taskValue.getSourceFile());
    if (!localExport.initializer || !isTaskDefineCall(localExport.initializer, taskFactory)) {
      return reusableIssue({ kind: "invalid-reusable-task-export", importedName: localExport.exportName, file: ctx.workflowFile, reason: "not-task-define" });
    }
    return {
      inline: false,
      metadata: {
        inline: false,
        sourceFile: ctx.workflowFile,
        exportName: localExport.exportName,
        sourceKind: "workflow-module",
      },
    };
  }
  if (ctx.locals.has(name) && !ctx.imports.has(name)) {
    return reusableIssue({ kind: "workflow-local-reusable-task", name });
  }
  return undefined;
}

function reusableMetadata(sourceFile: string, exportName: string, sourceKind: "task-module" | "workflow-module"): AnalyzedTask {
  return {
    inline: false,
    metadata: {
      inline: false,
      sourceFile,
      exportName,
      sourceKind,
    },
  };
}

function analyzeInline(exec: ts.FunctionLikeDeclarationBase): AnalyzedTask {
  const free = collectFreeIdentifiers(exec);
  if (free.length > 0) {
    return {
      inline: true,
      issue: { kind: "inline-task-capture", names: free },
    };
  }
  return { inline: true, metadata: { inline: true } };
}

function reusableIssue(issue: TaskAuthoringIssue): AnalyzedTask {
  return { inline: false, issue };
}

function withIssueSource(analyzed: AnalyzedTask, callsite: TaskCallsite): AnalyzedTask {
  if (!analyzed.issue) return analyzed;
  return { ...analyzed, source: callsite.source };
}

function setAnalyzedCallsite(analysis: WorkflowTaskAnalysis, callsite: TaskCallsite, analyzed: AnalyzedTask): void {
  if (analysis.has(callsite.stepId)) {
    analysis.set(callsite.stepId, {
      inline: false,
      issue: { kind: "ambiguous-task-callsite" },
      source: callsite.source,
    });
    return;
  }
  analysis.set(callsite.stepId, analyzed);
}
