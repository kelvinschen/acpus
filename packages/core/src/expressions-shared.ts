/**
 * Primitives shared by the expression collector (expressions.ts) and the AST
 * reference extractor (cel-ast.ts), kept in their own module to avoid a circular
 * import between those two files.
 */

export const EXPRESSION_PATTERN = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;

/**
 * The CEL parser/evaluator does not allow `loop` as a bare identifier root in
 * every position, so Acpus rewrites the logical `loop.` scope to `loop_ctx.`
 * before parsing or evaluating. The runtime evaluator binds `loop_ctx`
 * accordingly; the AST extractor normalizes it back to `loop`.
 *
 * The negative lookbehind keeps `loop.` rooted: a dotted access like
 * `steps.loop.output` (a step named `loop`) is left untouched, since `\b`
 * alone matches at the `.`→`l` boundary and would corrupt the reference.
 */
export function toCelParseSource(source: string): string {
  return source.replace(/(?<!\.)\bloop\./g, "loop_ctx.");
}
