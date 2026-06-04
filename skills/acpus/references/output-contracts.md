# Output Schema Reference

Workflow agent output uses `output.schema` DSL. Omitted schemas default to:

```text
{summary:string,data?:unknown}
```

Supported DSL features: primitives, `unknown`, literals, arrays, objects, optional keys, and unions.

Unsupported: `any`, `Record`, type aliases.

Examples:

```yaml
output:
  schema: "{summary:string,data?:[{path:string,severity?:string}]}"
```

```yaml
output:
  schema: "{summary:string,data?:[{kind:string,path?:string,status?:string,summary?:string}]}"
```

Implicit runtime fields:

- Gate agent output requires `verdict`.
- Route agent output requires `route`.
- Successful agent output is strict: fields outside the effective schema are rejected, and runtime does not inject a `status` content field.

Program tasks and program fanin do not use `output.schema`; they output `{status,data}`.

Prompt footers end with a single current output schema section:

````md
# Final Output Contract

**After completing the whole task, respond with exactly one valid, parseable final JSON object without ```json fence that satisfies this schema; the response must start with `{` and end with `}` and include no prose, Markdown, or code fences.**

```typescript
{summary:string,data?:unknown}
```
````

Runtime-internal troubleshooting helpers use private schemas; workflow-authored agent outputs are declared with `output.schema`.
