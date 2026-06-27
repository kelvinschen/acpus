# Schema Spec

## Purpose

The Acpus Schema DSL is a concise YAML-native syntax for declaring structured data contracts that compile into validation schemas used by Workflow Specs and runtime components.

## Requirements

- The Schema DSL MUST declare schema fields as a YAML object map.
- The Schema DSL MUST support required fields by default and optional fields with a `?` key suffix.
- The Schema DSL MUST support primitive field declarations using `string`, `integer`, `number`, `boolean`, `array`, and `object` type strings.
- Type names MUST be case-insensitive and MUST compile to lowercase canonical forms.
- The Schema DSL MUST accept type aliases: `int` → `integer`, `str` → `string`, `bool` → `boolean`, `num` → `number`.
- String shorthand field declarations MUST support an optional default value using the syntax `type = value`, such as `integer = 5`, `string = "hello"`, or `boolean = true`.
- Default values in string shorthand MUST be parsed as integers, floats, booleans, null, quoted strings, or unquoted strings.
- Fields with a default value MUST be implicitly optional and omitted from compiled `required` lists unless object-form `required: true` overrides requiredness.
- The Schema DSL MUST support nested object fields by declaring a field value as a map without a `type` key.
- The Schema DSL MUST support array fields by declaring a field value as a single-item YAML list.
- Array item schemas MUST support primitive type strings, nested object schema maps, object-form field declarations, and nested array schemas.
- A single-item YAML list containing `string` MUST declare an array of strings.
- A single-item YAML list containing a nested object schema map MUST declare an array of objects matching that nested schema.
- Compiled schemas MUST include nested object and array item structure.
- The Schema DSL compiler MUST support strict and open object-key modes.
- In strict object-key mode, compiled schemas MUST include `additionalProperties: false` on all object types, including root objects, nested objects, and bare `object` type fields.
- In open object-key mode, compiled object schemas MUST omit `additionalProperties: false`, so validation allows fields beyond the declared properties.
- Object-form field declarations MAY use only `type`, `required`, `default`, and `description` keys.
- Object-form field declarations with unsupported schema keys such as `items`, `properties`, or `elements` MUST be rejected instead of silently ignored.
- Object-form `description` MUST be preserved only when it is a string.
- Object-form `required` MUST override key suffix and default-value requiredness.

## Verification

- Compiler tests MUST cover Schema DSL primitive fields, optional fields, aliases, defaults, object-form declarations, and invalid field types.
- Compiler tests MUST cover nested objects, arrays of objects, arrays of primitives, nested arrays, and optional nested fields.
- Compiler tests MUST cover strict object compilation with `additionalProperties: false` and open object compilation without it.
- Compiler tests MUST cover unsupported object-form schema keys.
