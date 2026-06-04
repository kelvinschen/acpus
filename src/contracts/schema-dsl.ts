import { z } from "zod";

export type SchemaAst =
  | { kind: "primitive"; name: "string" | "number" | "boolean" | "null" | "unknown" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; item: SchemaAst }
  | { kind: "object"; fields: Array<{ name: string; optional: boolean; schema: SchemaAst }> }
  | { kind: "union"; options: SchemaAst[] };

export type CompiledSchema = {
  source: string;
  ast: SchemaAst;
};

type Token =
  | { type: "identifier"; value: string }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "symbol"; value: "{" | "}" | "[" | "]" | ":" | "?" | "," | "|" };
type SymbolValue = Extract<Token, { type: "symbol" }>["value"];

export const DEFAULT_AGENT_OUTPUT_SCHEMA: CompiledSchema = {
  source: "{summary:string,data?:unknown}",
  ast: {
    kind: "object",
    fields: [
      { name: "summary", optional: false, schema: { kind: "primitive", name: "string" } },
      { name: "data", optional: true, schema: { kind: "primitive", name: "unknown" } }
    ]
  }
};

export function compileSchemaDsl(source: string): CompiledSchema {
  const parser = new Parser(tokenize(source), source);
  const ast = parser.parseSchema();
  parser.expectEnd();
  return { source, ast };
}

export function zodForCompiledSchema(schema: CompiledSchema, implicitFields: Record<string, z.ZodType> = {}): z.ZodType<Record<string, unknown>> {
  let base = zodForAst(schema.ast);
  if (!(base instanceof z.ZodObject)) {
    throw new Error("Workflow schema root must be an object.");
  }
  if (Object.keys(implicitFields).length > 0) {
    base = base.extend(implicitFields);
  }
  return base as z.ZodType<Record<string, unknown>>;
}

export function defaultAgentOutputZod(implicitFields: Record<string, z.ZodType> = {}): z.ZodType<Record<string, unknown>> {
  const base = z.object({
    summary: z.string(),
    data: z.unknown().optional()
  }).strict();
  return Object.keys(implicitFields).length > 0 ? base.extend(implicitFields) : base;
}

export function outputSchemaFooter(schema: CompiledSchema | undefined, implicit: string[] = []): string {
  const schemaAst = withImplicitFields(schema?.ast ?? DEFAULT_AGENT_OUTPUT_SCHEMA.ast, implicit);
  const schemaText = formatSchema(schemaAst);
  const lines = [
    "",
    "# Final Output Contract",
    "",
    "**After completing the whole task, respond with exactly one valid, parseable final JSON object without ```json fence that satisfies this schema; the response must start with `{` and end with `}` and include no prose, Markdown, or code fences.**",
    "",
    "```typescript",
    schemaText,
    "```"
  ];
  return lines.join("\n");
}

function withImplicitFields(ast: SchemaAst, implicit: string[]): SchemaAst {
  if (implicit.length === 0 || ast.kind !== "object") return ast;
  const implicitFields = implicit.map((name) => implicitField(name));
  return {
    kind: "object",
    fields: [
      ...ast.fields.filter((field) => !implicitFields.some((implicitField) => implicitField.name === field.name)),
      ...implicitFields
    ]
  };
}

function implicitField(name: string): { name: string; optional: false; schema: SchemaAst } {
  if (name.startsWith("route:")) {
    return { name: "route", optional: false, schema: routeFieldSchema(name) };
  }
  return { name, optional: false, schema: implicitFieldSchema(name) };
}

function implicitFieldSchema(name: string): SchemaAst {
  if (name === "verdict") {
    return {
      kind: "union",
      options: [
        { kind: "literal", value: "pass" },
        { kind: "literal", value: "pass_with_warnings" },
        { kind: "literal", value: "blocked" },
        { kind: "literal", value: "failed" },
        { kind: "literal", value: "unknown" }
      ]
    };
  }
  if (name.startsWith("route:")) return routeFieldSchema(name);
  return { kind: "primitive", name: "string" };
}

function routeFieldSchema(name: string): SchemaAst {
  const routes = name.slice("route:".length).split("|").filter(Boolean);
  if (routes.length === 0) return { kind: "primitive", name: "string" };
  return {
    kind: "union",
    options: routes.map((route) => ({ kind: "literal", value: route }))
  };
}

export function formatSchema(ast: SchemaAst, indent = 0): string {
  const pad = " ".repeat(indent);
  switch (ast.kind) {
    case "primitive":
      return ast.name;
    case "literal":
      return JSON.stringify(ast.value);
    case "array": {
      if (ast.item.kind === "object") {
        return `[${formatSchema(ast.item, indent)}]`;
      }
      return `${formatSchema(ast.item, indent)}[]`;
    }
    case "object": {
      if (ast.fields.length === 0) return "{}";
      const inner = ast.fields
        .map((field) => `${" ".repeat(indent + 2)}${field.name}${field.optional ? "?" : ""}: ${formatSchema(field.schema, indent + 2)}`)
        .join(",\n");
      return `{\n${inner}\n${pad}}`;
    }
    case "union":
      return ast.options.map((option) => formatSchema(option, indent)).join(" | ");
  }
}

function zodForAst(ast: SchemaAst): z.ZodType {
  switch (ast.kind) {
    case "primitive":
      if (ast.name === "string") return z.string();
      if (ast.name === "number") return z.number();
      if (ast.name === "boolean") return z.boolean();
      if (ast.name === "unknown") return z.unknown();
      return z.null();
    case "literal":
      return z.literal(ast.value);
    case "array":
      return z.array(zodForAst(ast.item));
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      for (const field of ast.fields) {
        const fieldSchema = zodForAst(field.schema);
        shape[field.name] = field.optional ? fieldSchema.optional() : fieldSchema;
      }
      return z.object(shape).strict();
    }
    case "union":
      if (ast.options.length === 1) return zodForAst(ast.options[0]);
      return z.union(ast.options.map((option) => zodForAst(option)) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if ("{}[]:?,".includes(char) || char === "|") {
      tokens.push({ type: "symbol", value: char as SymbolValue });
      index += 1;
      continue;
    }
    if (char === "\"") {
      let end = index + 1;
      let escaped = false;
      let value = "";
      for (; end < source.length; end += 1) {
        const current = source[end];
        if (escaped) {
          value += current;
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === "\"") {
          break;
        } else {
          value += current;
        }
      }
      if (source[end] !== "\"") throw new Error("Unterminated string literal in schema.");
      tokens.push({ type: "string", value });
      index = end + 1;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(index));
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(index));
    if (identifier) {
      const value = identifier[0];
      if (value === "true" || value === "false") tokens.push({ type: "boolean", value: value === "true" });
      else tokens.push({ type: "identifier", value });
      index += value.length;
      continue;
    }
    throw new Error(`Unexpected schema character "${char}".`);
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[], private readonly source: string) {}

  parseSchema(): SchemaAst {
    const options = [this.parsePrimary()];
    while (this.consume("|")) options.push(this.parsePrimary());
    return options.length === 1 ? options[0] : { kind: "union", options };
  }

  expectEnd(): void {
    if (this.peek()) throw new Error(`Unexpected token after schema: ${this.tokenText(this.peek())}.`);
    void this.source;
  }

  private parsePrimary(): SchemaAst {
    const token = this.peek();
    if (!token) throw new Error("Unexpected end of schema.");
    if (this.consume("{")) return this.parseObject();
    if (this.consume("[")) {
      const item = this.parseSchema();
      this.expect("]");
      return { kind: "array", item };
    }
    this.index += 1;
    if (token.type === "identifier") {
      if (token.value === "string" || token.value === "number" || token.value === "boolean" || token.value === "null" || token.value === "unknown") {
        return { kind: "primitive", name: token.value };
      }
      if (token.value === "any" || token.value === "Record") {
        throw new Error(`Unsupported schema token "${token.value}".`);
      }
      throw new Error(`Unknown schema identifier "${token.value}".`);
    }
    if (token.type === "string" || token.type === "number" || token.type === "boolean") {
      return { kind: "literal", value: token.value };
    }
    throw new Error(`Unexpected schema token ${this.tokenText(token)}.`);
  }

  private parseObject(): SchemaAst {
    const fields: Extract<SchemaAst, { kind: "object" }>["fields"] = [];
    if (this.consume("}")) return { kind: "object", fields };
    do {
      const nameToken = this.peek();
      if (!nameToken || (nameToken.type !== "identifier" && nameToken.type !== "string")) {
        throw new Error("Object field name must be an identifier or string literal.");
      }
      this.index += 1;
      const optional = this.consume("?");
      this.expect(":");
      fields.push({ name: String(nameToken.value), optional, schema: this.parseSchema() });
    } while (this.consume(","));
    this.expect("}");
    return { kind: "object", fields };
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(symbol: SymbolValue): boolean {
    const token = this.peek();
    if (token?.type === "symbol" && token.value === symbol) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expect(symbol: SymbolValue): void {
    if (!this.consume(symbol)) throw new Error(`Expected "${symbol}" in schema.`);
  }

  private tokenText(token: Token | undefined): string {
    if (!token) return "<end>";
    return token.type === "symbol" ? token.value : String(token.value);
  }
}
