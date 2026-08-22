import { writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as ts from "typescript/unstable/ast";
import { createScratchDir } from "./preflight/temp.js";
import { withNativeProject } from "./typescript/native.js";

export type WorkflowMetadata = {
  name: string;
};

export type WorkflowMetadataError =
  | { type: "typescript-analysis-failed"; message: string }
  | { type: "syntax-invalid"; message: string }
  | { type: "default-export-missing"; message: string }
  | { type: "workflow-definition-not-static"; message: string }
  | { type: "workflow-name-not-static"; message: string };

/** Extract authored workflow metadata without importing or executing the module. */
export function extractWorkflowMetadata(source: string, fileName: string): Effect.Effect<WorkflowMetadata, WorkflowMetadataError> {
  return Effect.tryPromise({
    try: () => extract(source, resolve(fileName)),
    catch: cause => ({
      type: "typescript-analysis-failed",
      message: `Workflow metadata analysis failed: ${causeMessage(cause)}`,
    } satisfies WorkflowMetadataError),
  }).pipe(Effect.flatMap(Effect.fromResult));
}

async function extract(source: string, fileName: string): Promise<Result.Result<WorkflowMetadata, WorkflowMetadataError>> {
  const scratchDir = await createScratchDir();
  const configPath = join(scratchDir, "tsconfig.json");
  try {
    await writeFile(configPath, `${JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        skipLibCheck: true,
        target: "es2022",
      },
      files: [fileName],
    }, null, 2)}\n`);
    const analyzed = await withNativeProject({
      configPath,
      cwd: dirname(fileName),
      sourcePath: fileName,
      source,
    }, ({ project, sourceFile }) => {
      if (project.program.getSyntacticDiagnostics(sourceFile.path).length > 0) {
        return Result.fail({
          type: "syntax-invalid",
          message: "Workflow source contains TypeScript syntax errors.",
        } satisfies WorkflowMetadataError);
      }
      return extractFromSourceFile(sourceFile);
    });
    return Result.flatMap(
      Result.mapError(analyzed, failure => ({
        type: "typescript-analysis-failed",
        message: failure.message,
      } satisfies WorkflowMetadataError)),
      result => result,
    );
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function extractFromSourceFile(sourceFile: ts.SourceFile): Result.Result<WorkflowMetadata, WorkflowMetadataError> {
  const namedFactories = new Set<string>();
  const namespaces = new Set<string>();
  const variables = new Map<string, ts.Expression | undefined>();
  let defaultExport: ts.Expression | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && isCoreAuthoringSpecifier(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "defineWorkflow") namedFactories.add(element.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        variables.set(declaration.name.text, variables.has(declaration.name.text) ? undefined : declaration.initializer);
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (defaultExport) {
        return Result.fail({
          type: "workflow-definition-not-static",
          message: "Workflow module must have exactly one default export.",
        });
      }
      defaultExport = statement.expression;
    }
  }

  if (!defaultExport) {
    return Result.fail({
      type: "default-export-missing",
      message: "Workflow module must have a default export.",
    });
  }

  const exported = resolveTopLevelConst(unwrapExpression(defaultExport), variables);
  const config = workflowConfig(exported, namedFactories, namespaces);
  if (!config) {
    return Result.fail({
      type: "workflow-definition-not-static",
      message: "Default export must be a statically identifiable defineWorkflow(...).build(...) expression.",
    });
  }

  const name = staticWorkflowName(config);
  if (name === undefined) {
    return Result.fail({
      type: "workflow-name-not-static",
      message: "defineWorkflow({ name }) must resolve to a direct string literal after object spread ordering.",
    });
  }
  return Result.succeed({ name });
}

function workflowConfig(
  expression: ts.Expression | undefined,
  namedFactories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ts.ObjectLiteralExpression | undefined {
  expression = expression && unwrapExpression(expression);
  if (!expression || !ts.isCallExpression(expression)) return undefined;
  const build = expression.expression;
  if (!ts.isPropertyAccessExpression(build) || build.name.text !== "build") return undefined;
  const definition = unwrapExpression(build.expression);
  if (!ts.isCallExpression(definition) || !isDefineWorkflowCallee(definition.expression, namedFactories, namespaces)) return undefined;
  const config = definition.arguments[0];
  return config && ts.isObjectLiteralExpression(config) ? config : undefined;
}

function isDefineWorkflowCallee(
  expression: ts.Expression,
  namedFactories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expression)) return namedFactories.has(expression.text);
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === "defineWorkflow"
    && ts.isIdentifier(expression.expression)
    && namespaces.has(expression.expression.text);
}

function staticWorkflowName(config: ts.ObjectLiteralExpression): string | undefined {
  let name: string | undefined;
  for (const property of config.properties) {
    if (ts.isSpreadAssignment(property)) {
      name = undefined;
      continue;
    }
    const key = propertyName(property.name);
    if (key === undefined && property.name && ts.isComputedPropertyName(property.name)) {
      name = undefined;
      continue;
    }
    if (key !== "name") continue;
    if (!ts.isPropertyAssignment(property)) {
      name = undefined;
      continue;
    }
    const value = unwrapExpression(property.initializer);
    name = ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
  }
  return name;
}

function resolveTopLevelConst(expression: ts.Expression, variables: ReadonlyMap<string, ts.Expression | undefined>): ts.Expression | undefined {
  if (!ts.isIdentifier(expression)) return expression;
  return variables.get(expression.text);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
}

function isCoreAuthoringSpecifier(specifier: string): boolean {
  return specifier === "acpus/core" || specifier === "@acpus/core";
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
