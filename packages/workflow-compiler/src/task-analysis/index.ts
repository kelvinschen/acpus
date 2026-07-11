import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, type Result } from "neverthrow";
import * as ts from "typescript/unstable/ast";
import type { SourceFile } from "typescript/unstable/ast";
import { nativeFailure, withNativeProject, type TypeScriptNativeFailure } from "../typescript/native.js";
import { execFunction, isTaskDefineCall, objectProperty, taskFactoryLocalName } from "./ast.js";
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

export async function analyzeWorkflowTasks(
  workflowFile: string,
  source: string,
): Promise<Result<WorkflowTaskAnalysis, TypeScriptNativeFailure>> {
  let scratchDir: string;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), "acpus-task-analysis-"));
  } catch (cause) {
    return err(nativeFailure(cause));
  }
  const configPath = join(scratchDir, "tsconfig.json");
  let result: Result<WorkflowTaskAnalysis, TypeScriptNativeFailure>;
  try {
    await writeFile(configPath, `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        noLib: true,
        noResolve: true,
        skipLibCheck: true,
      },
      files: [workflowFile],
    }, null, 2)}\n`);
    result = await withNativeProject(
      { configPath, cwd: dirname(workflowFile), sourcePath: workflowFile, source },
      ({ sourceFile }) => analyzeWorkflowTasksFromSourceFile(workflowFile, sourceFile),
    );
  } catch (cause) {
    result = err(nativeFailure(cause));
  }
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch (cause) {
    if (result.isOk()) return err(nativeFailure(cause));
  }
  return result;
}

export function analyzeWorkflowTasksFromSourceFile(workflowFile: string, sourceFile: SourceFile): WorkflowTaskAnalysis {
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
  const taskValue = objectProperty(callsite.options, "task");
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

function analyzeInline(exec: ts.FunctionLikeDeclaration): AnalyzedTask {
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
