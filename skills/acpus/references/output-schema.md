# Output Schema Reference

Workflow agent output uses `output.schema` DSL. Omitted schemas default to:

```text
{summary:string,data?:unknown}
```

## DSL Syntax

| Syntax | Meaning | Example |
|--------|---------|---------|
| `string` | String primitive | `{name:string}` |
| `number` | Number primitive | `{count:number}` |
| `boolean` | Boolean primitive | `{valid:boolean}` |
| `unknown` | Any value | `{meta?:unknown}` |
| `'literal'` | Literal string | `{kind:'docs'|'code'}` |
| `[type]` | Array of type | `{items:[string]}` |
| `{key:type}` | Object with required key | `{name:string}` |
| `{key?:type}` | Object with optional key | `{path?:string}` |
| `A\|B` | Union of types | `{status:'pass'\|'blocked'}` |

Supported: primitives (`string`, `number`, `boolean`), `unknown`, literals, arrays, objects, optional keys, and unions.

Unsupported: `any`, `Record`, type aliases.

## Examples

Simple agent output:

```yaml
output:
  schema: "{summary:string,data?:[{path:string,severity?:string}]}"
```

Review output with discriminated union:

```yaml
output:
  schema: "{summary:string,data?:[{kind:string,path?:string,status?:string,summary?:string}]}"
```

Using literals and union:

```yaml
output:
  schema: "{summary:string,kind:'docs'|'code',count?:number,items?:[string]}"
```

## Implicit Runtime Fields

These fields are automatically required by the stage kind, independent of `output.schema`:

- **Gate agent** output requires `verdict` (`pass` | `pass_with_warnings` | `blocked` | `failed` | `unknown`).
- **Route agent** output requires `route` (must match one of the `routes` list IDs).

Successful agent output must conform exactly to the effective schema: fields outside the schema are rejected, and runtime does not inject a `status` content field.

Program tasks and program fanin do not use `output.schema`; they output `{status,data}`.

## Prompt Footer Template

Agent prompts receive a structured output schema footer:

````md
# Final Output Schema

**After completing the whole task, respond with exactly one valid, parseable final JSON object without ```json fence that satisfies this schema; the response must start with `{` and end with `}` and include no prose, Markdown, or code fences.**

```typescript
{summary:string,data?:unknown}
```
````

The same DSL is used for `input.schema` declarations.

Runtime-internal troubleshooting helpers use private schemas; workflow-authored agent outputs are declared with `output.schema`.
