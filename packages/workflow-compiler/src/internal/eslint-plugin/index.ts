import type { DiagnosticIR } from "@acpus/core/ir";
import type { ESLint, Rule } from "eslint";
import ts from "typescript";
import { checkWorkflowAuthoring } from "../../check/authoring-rules/index.js";
import { analyzeWorkflowTasksSync } from "../../task-analysis/index.js";

// Internal editor plugin for Acpus fixture review only. It is intentionally a
// thin adapter over check/authoring-rules, not a product check entrypoint and
// not the owner of Acpus rule semantics.

type ParserServices = {
  program?: ts.Program;
  esTreeNodeToTSNodeMap?: Map<unknown, ts.Node>;
};

const checkRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Run internal Acpus authoring checks for workflow fixtures.",
    },
    schema: [],
  },
  create(context) {
    return {
      "Program:exit"(node: unknown) {
        const sourceCode = context.sourceCode;
        const services = parserServices(context);
        const program = services?.program;
        const sourceFile = sourceFileForNode(node, services) ?? program?.getSourceFile(context.filename);
        if (!program || !sourceFile) {
          context.report({
            loc: { line: 1, column: 0 },
            message: "Acpus internal check requires @typescript-eslint/parser with typed parser services. Configure parserOptions.project for workflow fixtures.",
          });
          return;
        }

        const diagnostics = checkWorkflowAuthoring({
          program,
          sourceFile,
          taskAnalysis: analyzeWorkflowTasksSync(sourceFile.fileName, sourceCode.text),
        });
        for (const diagnostic of diagnostics) {
          context.report({
            loc: reportLocation(diagnostic),
            message: reportMessage(diagnostic),
          });
        }
      },
    };
  },
};

const rules: Record<string, Rule.RuleModule> = {
  check: checkRule,
};

const plugin: ESLint.Plugin = {
  meta: {
    name: "@acpus/workflow-compiler/internal/eslint-plugin",
  },
  rules,
};

export default plugin;

function parserServices(context: Rule.RuleContext): ParserServices | undefined {
  const sourceCode = context.sourceCode;
  return (sourceCode as { parserServices?: ParserServices }).parserServices
    ?? (context as { parserServices?: ParserServices }).parserServices;
}

function sourceFileForNode(node: unknown, services: ParserServices | undefined): ts.SourceFile | undefined {
  const tsNode = services?.esTreeNodeToTSNodeMap?.get(node);
  return tsNode?.getSourceFile();
}

function reportMessage(diagnostic: DiagnosticIR): string {
  return `${diagnostic.code}: ${diagnostic.message}${diagnostic.hint ? `\nHint: ${diagnostic.hint}` : ""}`;
}

function reportLocation(diagnostic: DiagnosticIR): { line: number; column: number } {
  if (!diagnostic.source) return { line: 1, column: 0 };
  return {
    line: diagnostic.source.line ?? 1,
    column: Math.max(0, (diagnostic.source.column ?? 1) - 1),
  };
}
