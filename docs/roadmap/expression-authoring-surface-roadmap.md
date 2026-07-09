# Expression Authoring Surface Implementation Plan

本文是 Expression authoring surface 的落地执行计划，不再是普通 roadmap。实现时按这里的决定改代码、测试、文档；如果实现中发现新的约束，先回到本文更新决策，再继续改代码。

## 目标

Acpus workflow authoring 面向 agent 生成 TypeScript workflow，不面向依赖 IDE completion 的人类操作。Expression surface 要满足：

- agent 通过 skill 文档和 workflow 模板能自然写出。
- TypeScript 类型系统尽量完整表达约束。
- runtime expression graph 仍然可序列化、可检查、可持久执行。
- public interface 小而深，删除大量低频 shallow helpers。
- 项目未上线，不为旧 helper 做前向兼容。

## 最终 Public Surface

第一期 root authoring surface 只保留：

```ts
template
md
fmap
lift2
lift3
lift
```

public 类型以 `ExprValue<T>` 为 agent-facing expression token 名字：

```ts
Expr<T>
ExprValue<T>
WorkflowValue<T>
WorkflowData
```

实现时直接把 public authoring type 从 `OutputAccessor<T>` rename 为 `ExprValue<T>`。root package 不再导出 `OutputAccessor<T>`；内部代码同步迁移到 `ExprValue<T>`，不为旧名字保留兼容 alias。

以下 helper 从 root export、实现、validator/evaluator operator、测试和文档中删除，不保留 alias，不保留 internal fallback：

```ts
not, and, or
eq, ne, lt, lte, gt, gte
add, subtract, multiply, divide, mod
ifElse, coalesce
len, includes, isEmpty, startsWith, endsWith, matches
get, head
every, some, map, filter
join, max, min
where, pick
transform
```

未来如果 eval 证明 `eq` / `and` / `or` 重新有价值，按新的 ergonomics 重新设计并实现，不能复活旧实现。

## Function Signatures

核心类型：

```ts
export type WorkflowData =
  | string
  | number
  | boolean
  | null
  | readonly WorkflowData[]
  | { readonly [key: string]: WorkflowData };

export type ExprValue<T> = Expr<T> & accessors-for-T;
export type WorkflowValue<T = WorkflowData> =
  | ExprValue<T>
  | workflow-literal-containing-WorkflowValue;
```

`WorkflowData` 是 callback output 的 admissible type。`undefined`、function、symbol、bigint、class instance、Date、Promise、thenable 都不是 admissible output。

`fmap`：

```ts
export function fmap<A, R extends WorkflowData>(
  value: WorkflowValue<A>,
  fn: (value: A) => R,
): ExprValue<R>;
```

`lift2`：

```ts
export function lift2<A, B, R extends WorkflowData>(
  a: WorkflowValue<A>,
  b: WorkflowValue<B>,
  fn: (a: A, b: B) => R,
): ExprValue<R>;
```

`lift3`：

```ts
export function lift3<A, B, C, R extends WorkflowData>(
  a: WorkflowValue<A>,
  b: WorkflowValue<B>,
  c: WorkflowValue<C>,
  fn: (a: A, b: B, c: C) => R,
): ExprValue<R>;
```

`lift`：

```ts
type LiftDeps = {
  readonly [key: string]: WorkflowValue;
};

type ResolvedLiftDeps<D extends LiftDeps> = {
  readonly [K in keyof D]: D[K] extends WorkflowValue<infer T> ? T : never;
};

export function lift<const D extends LiftDeps, R extends WorkflowData>(
  deps: D,
  fn: (deps: ResolvedLiftDeps<D>) => R,
): ExprValue<R>;
```

实现注意：

- TypeScript 负责拒绝 async callback，因为 `Promise<T>` 不满足 `R extends WorkflowData`。
- TypeScript 负责拒绝 non-workflow-data return，例如 `Date`、`undefined`、function。
- runtime 仍保留 thenable check 和 JSON compatibility check 作为 backstop。
- `lift` 第一参数必须是 plain named object；runtime lowering 也要拒绝 array、function、class instance。
- 不提供 variadic `lift(a, b, c, fn)`。
- 不提供 tuple-form `lift([a, b], ...)`。
- 不提供 `liftN`。

使用约定：

```ts
fmap(expr, value => value.trim());

lift2(input.ready, input.kind, (ready, kind) =>
  ready && kind === "release"
);

lift3(input.priority, selectedCount, input.maxItems, (priority, selectedCount, maxItems) =>
  priority === "high" || selectedCount > maxItems
);

lift(
  { priority: input.priority, selectedCount, maxItems: input.maxItems },
  ({ priority, selectedCount, maxItems }) =>
    priority === "high" || selectedCount > maxItems
);
```

## Why No Tuple Lift

`lift2` / `lift3` already cover concise positional cases. `lift([a, b, c], ([a, b, c]) => ...)` saves a few characters but makes common errors harder to diagnose:

```ts
const allowed = lift(
  [input.kind, input.ready, input.maxItems],
  ([kind, ready, maxItems]) => ready && kind === "release" && maxItems > 0
);
```

如果后续有人调整 dependency order：

```ts
const allowed = lift(
  [input.ready, input.kind, input.maxItems],
  ([kind, ready, maxItems]) => ready && kind === "release" && maxItems > 0
);
```

TypeScript 只会看到 tuple position，不知道 `kind` 和 `ready` 的语义名字。named-object `lift` 会把这个错误变成明显的字段名变更：

```ts
const allowed = lift(
  { ready: input.ready, kind: input.kind, maxItems: input.maxItems },
  ({ ready, kind, maxItems }) => ready && kind === "release" && maxItems > 0
);
```

因此第一期规则是：1 个 dependency 用 `fmap`，2/3 个 dependency 用 `lift2` / `lift3`，更多 dependency 或需要可读名字时用 named-object `lift`。

## No Typed Method Facade In Phase 1

第一期不实现：

```ts
input.items.length
input.items.map(...)
input.items.filter(...)
input.title.trim()
input.ready.and(...)
```

数组、字符串、数字、布尔、对象转换都走 `fmap` / `lift2` / `lift3` / `lift`：

```ts
const itemCount = fmap(input.items, items => items.length);

const itemIds = fmap(input.items, items =>
  items.map(item => item.id)
);

const selectedItems = lift2(input.items, input.kind, (items, kind) =>
  items.filter(item => item.kind === kind)
);

const compactTitle = fmap(input.title, title =>
  title.trim().replace(/\s+/g, " ")
);
```

原因：

- array facade 需要 proxy special-case、TypeIR 稳定传播、field collision 策略和额外 callback call-shape 检测。
- string/boolean fluent methods 不是 agent 会自然生成的 JS 习惯。
- `fmap` / `lift` 的接口更小，checker/evaluator 逻辑也能集中在一处。

## IR And Lowering

第一期保留的 expression node kinds：

```ts
literal
ref
call
array
object
template
```

删除 `lambda` / `var` IR。它们只服务旧 `map` / `filter` / `where` 这类 expression-level lambda helper；新 surface 的 callback 用 source string 存储，不需要 lambda AST。

新增/保留的 call operators：

```ts
fmap
lift2
lift3
lift
access
```

`template` / `md` 继续 lowered 为 `template` IR，不进入 call operator。

lowering 规则：

```ts
fmap(value, fn)
// -> call("fmap", [valueIR, literal(fn.toString())])

lift2(a, b, fn)
// -> call("lift2", [aIR, bIR, literal(fn.toString())])

lift3(a, b, c, fn)
// -> call("lift3", [aIR, bIR, cIR, literal(fn.toString())])

lift({ a, b, c }, fn)
// -> call("lift", [object({ a: aIR, b: bIR, c: cIR }), literal(fn.toString())])
```

`get` 作为 public helper 删除。当前 accessor proxy 对 non-ref expression 的 property access 不能继续 lower 到 public-looking `get` operator；实现时改名为 internal `access` operator：

```ts
expr.someField
// ref expr: extend ref path
// call/object/template expr: call("access", [targetIR, literal("someField")])
```

`access` 是 internal expression projection primitive，不从 root authoring surface 导出。

## Evaluator Semantics

`fmap` / `lift2` / `lift3` / `lift` 共用一套 callback evaluator helper：

1. evaluate dependency IR。
2. 对每个传入 callback 的 resolved dependency 做 JSON-compatible deep clone。
3. 通过 `Function('"use strict"; return (' + source + ');')()` 加载 callback。
4. 检查加载结果是 function。
5. 调用 callback：
   - `fmap`: `fn(value)`
   - `lift2`: `fn(a, b)`
   - `lift3`: `fn(a, b, c)`
   - `lift`: `fn(depsObject)`
6. 如果 output 是 thenable，抛出 evaluation error。
7. 对 output 执行 workflow-data JSON compatibility check。

deep clone 是 runtime mutation 防线。我们不在 AST 里维护 `sort` / `push` / `splice` 这类 mutating method denylist；callback 修改的是 clone，不污染 adapter 返回的 runtime scope。

`access` evaluator：

- 沿用当前 projection 的 `MISSING` sentinel 语义。
- target 为 nullish 或字段不存在时返回 `MISSING`；进入 `fmap` / `lift` callback dependency 时转换为 transient `undefined`。
- target 为 array/string/object 时按 key 读取。
- 其他类型读取返回 `MISSING`。

## Check And Diagnostics

第一原则：能用 TypeScript 限制的，不用 AST check。

TypeScript 负责：

- `fmap` / `lift2` / `lift3` / `lift` call shape。
- callback arity。
- callback input resolved type inference。
- sync callback return。`async` callback 会返回 `Promise<T>`，不满足 `WorkflowData`。
- callback output admissibility 的第一层类型限制。
- `lift([a, b], ...)`、`lift(a, b, fn)` 等非目标写法通过类型错误暴露，不新增 AST rule。

AST checker 只负责：

- callback 必须是 inline arrow function。
- callback 必须是 expression body，不能是 block body。
- callback body 不能引用 callback 参数、nested callback 参数之外的 lexical binding。
- workflow check 可以继续用现有 output admissibility 逻辑给 callback return type 产出更明确的 diagnostic。

不做这些 AST rule：

- 不维护 method allowlist 或 denylist。
- 不禁止 `replace`、`reduce`、`flatMap`、`sort` 等普通 JS method。
- 不用 AST 专门禁止 `async` / `await` / `Promise`；类型系统和 runtime thenable backstop 负责。
- 不做 prototype / constructor escape 规则。
- 不做 curated global allowlist。`Math`、`JSON`、`Object`、`Array`、`Number`、`String`、`Boolean`、`Date` 等 runtime globals 按 inline task 模型允许，不算 external binding。
- 不做 mutation method denylist。

callback scope 规则：

- `fmap` callback 有且只有 1 个参数。
- `lift2` callback 有且只有 2 个参数。
- `lift3` callback 有且只有 3 个参数。
- `lift` callback 有且只有 1 个参数。
- 参数可以是 identifier 或 simple binding pattern，支持 `({ a, b }) => ...`。
- binding pattern 不支持 default initializer、rest element、computed property name；这些写法低频且容易扩大 checker 复杂度。
- nested arrow callback 允许，但也必须是 expression body；它的参数会加入 nested scope。
- property access 的 property name 不算 lexical binding，例如 `item.title` 只检查 `item`。
- object literal shorthand 会按 identifier reference 检查，例如 `{ title }` 需要 `title` 在 scope 内。
- external binding 只指 workflow/module lexical binding。runtime global names 不算 external binding。
- global access 不是 sandbox；`Date.now()`、`Math.random()`、`JSON.stringify(...)` 可以使用，但 callback output 仍必须通过 workflow-data admissibility。

诊断行为：

```ts
fmap(input.title, title => title.trim().replace(/\s+/g, " "));
// ok

fmap(input.title, title => {
  return title.trim();
});
// diagnostic: callback must be one expression

fmap(input.items, items =>
  items.filter(item => item.kind === input.kind)
);
// diagnostic: callback references external binding 'input'
// hint: use lift2(input.items, input.kind, (items, kind) => ...)

fmap(input.items, items =>
  items.map(item => item.id)
);
// ok

lift(
  { items: input.items, kind: input.kind },
  ({ items, kind }) => items.filter(item => item.kind === kind)
);
// ok
```

更新旧 diagnostics：

- `AL001` JS condition / `!expr` hint 改为 `fmap` / `lift2` / `lift`。
- `AL002` JS logical operator hint 改为 `lift2(a, b, (a, b) => a && b)` 或 named-object `lift`。
- `AL003` JS comparison operator hint 改为 `lift2(a, b, (a, b) => a === b)`。
- `AL004` 继续指向 `template` / `md`。
- `AL005` Expr array method hint 改为 `fmap(items, items => items.map/filter/length...)`。
- `AL007` 继续作为 callback authoring diagnostic code，但文案从 `transform(...)` 改为 `fmap/lift callback`。

移除旧 `transform` checker 的 method allowlist。Round 16 中 `transform(item.title, title => title.trim().replace(...))` 失败的根因是 `ALLOWED_TRANSFORM_METHODS` 包含 `trim` 但不包含 `replace`；新 checker 不能沿用这个架构。

## Implementation Slices

### 1. Public API Reset

Files:

- `packages/expression/src/index.ts`
- `packages/expression/src/internal/expr.ts`
- `packages/expression/src/ir.ts`
- `packages/expression/src/internal/operators.ts`

Tasks:

- Add `WorkflowData` and `ExprValue<T>` public types.
- Add `fmap`, `lift2`, `lift3`, `lift` root exports.
- Lower callbacks with `fn.toString()` source literal.
- Remove root exports for all old helpers.
- Rename internal non-ref projection from `get` to `access`.
- Remove `varExpr`; update any remaining production code so it no longer emits `var` IR.

Done when:

- `import { fmap, lift2, lift3, lift, template, md } from "@acpus/expression"` type-checks.
- importing old helpers from root fails with normal TypeScript missing export errors.

### 2. IR / Validator / Evaluator Cleanup

Files:

- `packages/expression/src/ir.ts`
- `packages/expression/src/validator.ts`
- `packages/expression/src/evaluator.ts`
- `packages/expression/src/internal/operators.ts`
- any graph/renderer code that pattern-matches `ExprIR`

Tasks:

- Delete `lambda` and `var` IR variants.
- Delete old operator specs.
- Add operator specs for `fmap`, `lift2`, `lift3`, `lift`, `access`.
- Validate callback source args as string literals.
- Implement shared callback evaluator helper.
- Deep clone callback inputs before invocation.
- Keep runtime thenable and JSON compatibility checks.
- Update renderers/tests that display old `lambda` / `var` shapes.

Done when:

- expression validator accepts only the new operator set.
- evaluator can run `fmap`, `lift2`, `lift3`, `lift`, and `access`.
- no production code imports `varExpr` or lowers `lambda`.

### 3. Callback Checker Refactor

Files:

- `packages/workflow-compiler/src/check/authoring-rules/index.ts`
- related authoring-rules tests / fixtures

Tasks:

- Replace `collectTransformImports` with collection for `fmap`, `lift2`, `lift3`, `lift`.
- Run callback checker on those calls only.
- Visit dependency arguments normally, but do not recursively apply generic Expr authoring rules inside accepted callback bodies.
- Implement inline expression-body arrow rule.
- Implement no-external-binding scope walk.
- Support identifier and simple binding-pattern params.
- Support nested expression-body arrow callbacks.
- Remove method allowlist and all method-specific diagnostics.
- Update AL001-AL005 hints to the new surface.
- Keep output admissibility diagnostic for callback return types.

Done when:

- `title.trim().replace(...)` passes.
- external Expr dependency inside callback fails with a migration hint.
- old `transform(...)`-specific diagnostics no longer exist.

### 4. Tests

Add or update tests covering:

- `fmap(input.title, title => title.trim().replace(/\s+/g, " "))` passes workflow check.
- `fmap(input.items, items => items.length)` passes.
- `fmap(input.items, items => items.map(item => item.id))` passes.
- `lift2(input.items, input.kind, (items, kind) => items.filter(item => item.kind === kind))` passes.
- `lift({ items: input.items, kind: input.kind }, ({ items, kind }) => items.filter(item => item.kind === kind))` passes.
- block-body callback fails.
- external binding inside callback fails.
- global access such as `Math.random()`, `JSON.stringify(...)`, and `Date.now()` passes when the output is workflow-data admissible.
- `async` callback fails through TypeScript / output type check.
- callback returning `undefined` fails.
- callback returning `Date` fails.
- import of old helpers fails.
- evaluator rejects thenable output at runtime.
- evaluator callback mutation does not mutate original dependency object.
- validator rejects old operator IR.
- validator rejects `lambda` / `var` IR.

### 5. Docs / Skill / Examples

Files:

- `specs/expression-spec.md`
- `specs/workflow-compiler-spec.md`
- Acpus skill authoring quick sheet
- examples / fixtures / eval-derived examples

Tasks:

- Replace `and` / `or` / `eq` / `len` / `map` / `filter` / `where` / `transform` examples.
- Teach this primary pattern:
  - 1 dependency: `fmap`
  - 2 dependencies: `lift2`
  - 3 dependencies: `lift3`
  - many or named dependencies: `lift({ deps }, fn)`
- Document that callback is pure expression over explicit dependencies.
- Document that globals follow inline task semantics: runtime globals are available, workflow/module locals must be passed explicitly through `fmap` / `lift2` / `lift3` / `lift`.
- Document that global access is not a sandbox guarantee; final output still must be workflow-data admissible.
- Document no array facade in phase 1.

Done when:

- agent-facing docs only present `template`, `md`, `fmap`, `lift2`, `lift3`, `lift` as Expression helpers.
- examples do not import deleted helpers.

## Verification Commands

Run from repo root:

```sh
pnpm test --filter @acpus/expression
pnpm test --filter @acpus/workflow-compiler
pnpm typecheck
```

Then run workflow checks on fixtures/examples touched by the migration:

```sh
acpus workflow check <workflow.ts> --input '<json>'
```

Use the Round 16 repro as a regression case:

```ts
fmap(item.title, title => title.trim().replace(/\s+/g, " "))
```

Expected result: no `AL007`.

## Deferred

These are deliberately out of first phase:

- Array computed facade: `.length` / `.map` / `.filter`. Numeric index access remains supported as projection, like object field access.
- String/number/boolean fluent methods.
- AST macro island such as `expr(() => ...)`.
- compute workflow node.
- variadic or tuple `lift`.
- `liftN`.
- curated global allowlist or sandbox-style global isolation.
- resurrecting `eq` / `and` / `or`.
