import ts from "typescript";
import { execFunction, isTaskDefineCall, objectProperty, parseSourceFile, taskFactoryLocalName } from "./ast.js";
import { findTaskCallsites } from "./callsites.js";
import { collectFreeIdentifiers } from "./inline-capture.js";
import type { ImportBinding, TaskAuthoringIssue, TaskReferenceMetadata, TaskCallsite, WorkflowTaskExport } from "./types.js";
import { collectImportBindings, collectLocalValueNames, collectWorkflowTaskExports, hasInnerBinding } from "./workflow-symbols.js";

// Static task analysis parses workflow modules with the TypeScript parser only.
// It produces facts and reusable reference metadata, not
// diagnostics. Authoring rules own rule codes, messages, and hints; compile
// consumes only metadata.

export type {
  TaskAnalysisFact,
  TaskAuthoringIssue,
  TaskReferenceMetadata,
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
  return analyzeWorkflowTasksSync(workflowFile, source);
}

function analyzeWorkflowTasksSync(workflowFile: string, source: string): WorkflowTaskAnalysis {
  const sourceFile = parseSourceFile(workflowFile, source);
  const imports = collectImportBindings(sourceFile);
  const locals = collectLocalValueNames(sourceFile);
  const localExports = collectWorkflowTaskExports(sourceFile);
  const analysis: WorkflowTaskAnalysis = new Map();
  for (const callsite of findTaskCallsites(sourceFile)) {
    setAnalyzedCallsite(analysis, callsite, analyzeCallsite(callsite, { workflowFile, imports, locals, localExports }));
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

export function resolveTaskReferenceMetadata(analysis: WorkflowTaskAnalysis): Map<string, TaskReferenceMetadata> {
  const metadata = new Map<string, TaskReferenceMetadata>();
  for (const [stepId, analyzed] of analysis) {
    if (analyzed.metadata) metadata.set(stepId, analyzed.metadata);
  }
  return metadata;
}

function analyzeCallsite(callsite: TaskCallsite, ctx: AnalyzeContext): AnalyzedTask {
  const run = objectProperty(callsite.options, "run");
  const taskValue = run && ts.isObjectLiteralExpression(run) ? objectProperty(run, "task") : undefined;
  if (taskValue) return withIssueSource(analyzeReusable(taskValue, ctx), callsite);
  const exec = execFunction(callsite.options);
  if (exec) return withIssueSource(analyzeInline(exec), callsite);
  return { inline: true };
}

function analyzeReusable(taskValue: ts.Expression, ctx: AnalyzeContext): AnalyzedTask {
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
  return reusableMetadata(binding.specifier, binding.importedName);
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
        specifier: `./${ctx.workflowFile.split(/[\\/]/).pop() ?? ""}`,
        exportName: localExport.exportName,
      },
    };
  }
  if (ctx.locals.has(name) && !ctx.imports.has(name)) {
    return reusableIssue({ kind: "workflow-local-reusable-task", name });
  }
  return undefined;
}

function reusableMetadata(specifier: string, exportName: string): AnalyzedTask {
  return {
    inline: false,
    metadata: {
      specifier,
      exportName,
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
  return { inline: true };
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
