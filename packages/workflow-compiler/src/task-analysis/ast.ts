import ts from "typescript";

export function parseSourceFile(file: string, source: string): ts.SourceFile {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
}

export function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && propertyName(member.name) === name) return member.initializer;
  }
  return undefined;
}

export function execFunction(spec: ts.ObjectLiteralExpression): ts.FunctionLikeDeclarationBase | undefined {
  const exec = objectProperty(spec, "exec");
  if (exec && (ts.isArrowFunction(exec) || ts.isFunctionExpression(exec))) return exec;
  return undefined;
}

export function taskFactoryLocalName(sourceFile: ts.SourceFile): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isCoreAuthoringSpecifier(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if ((element.propertyName ?? element.name).text === "task") return element.name.text;
      }
    }
  }
  return undefined;
}

export function isTaskDefineCall(expression: ts.Expression, taskFactory: string | undefined): boolean {
  if (!taskFactory || !ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  return ts.isPropertyAccessExpression(callee)
    && callee.name.text === "define"
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === taskFactory;
}

export function isExported(node: ts.VariableStatement): boolean {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

export function isConstVariableStatement(node: ts.VariableStatement): boolean {
  return (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function isCoreAuthoringSpecifier(specifier: string): boolean {
  return specifier === "acpus/core" || specifier === "@acpus/core";
}
