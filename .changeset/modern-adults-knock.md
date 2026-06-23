---
"@acpus/runtime": patch
"@acpus/core": patch
---

    Agent and Program output schemas are now open at runtime — extra fields
    beyond the declared schema are accepted and preserved in persisted Node
    state. Workflow expressions and composite parent outputs see only the
    declared fields, enforced by a new expressionOutputForNode projection
    layer in the interpreter.
    
    Signal output schemas remain strict (additionalProperties: false) and
    reject undeclared extra fields.
    
    Compiler changes:
    - Agent/Program schemas compiled without additionalProperties: false
    - Signal schemas stay strict
    - Expression validation rejects undeclared fields on open schemas
    - Static string indexes (output["field"]) treated as field references
    - Dynamic indexes rejected on schema objects, accepted only on arrays
      with declared item schemas
    
    Runtime changes:
    - expressionOutputForNode projects agent/program outputs to declared
      fields for expression context and composite parent outputs
    - Schema prompt updated: extra keys accepted but not available to
      expressions