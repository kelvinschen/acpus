// Internal type-level helpers. Keep this module small; business-specific
// workflow types should stay near the contracts they describe.
//
// If this grows, it is acceptable to reference or copy type-fest-style helper
// definitions after checking license, TypeScript compatibility, public .d.ts
// impact, and whether the helper changes authoring semantics.

export type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T] ? false : true
  : false;

export type Simplify<T> = {
  [KeyType in keyof T]: T[KeyType];
} & {};

export type ValueOf<T> = T[keyof T];
