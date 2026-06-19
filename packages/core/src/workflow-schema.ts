/**
 * JSON Schema definition for Acpus workflow YAML specs.
 *
 * Covers structural validation: types, enums, required fields, unknown-field
 * detection (additionalProperties: false), and if/then cross-field dependencies.
 * Semantic validation (cross-references, DSL compilation, duration format)
 * remains in the hand-written compiler code.
 */

const SAFE_AUTHOR_ID_PATTERN = "^[A-Za-z_][A-Za-z0-9_-]*$";

export const WORKFLOW_SCHEMA: Record<string, unknown> = {
  $defs: {
    // ── Agent definition ──
    agentSpec: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["builtin", "command"]
        },
        use: { type: "string" },
        model: { type: "string" },
        cwd: {},                       // any type — runtime coercion
        env: { type: "object" },        // free-form env vars
        policy: {
          type: "string",
          enum: ["read", "full"]
        }
      },
      required: ["use"]
    },

    // ── Step (oneOf dispatch) ──
    step: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        }
      },
      oneOf: [
        { $ref: "#/$defs/pipelineStep" },
        { $ref: "#/$defs/agentStep" },
        { $ref: "#/$defs/programStep" },
        { $ref: "#/$defs/parallelStep" },
        { $ref: "#/$defs/fanoutStep" },
        { $ref: "#/$defs/switchStep" },
        { $ref: "#/$defs/loopStep" },
        { $ref: "#/$defs/guardStep" },
        { $ref: "#/$defs/signalStep" },
        { $ref: "#/$defs/subworkflowStep" }
      ]
    },

    pipelineStep: {
      type: "object",
      additionalProperties: false,
      required: ["pipeline"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        pipeline: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/step" }
        },
        outputs: { type: "object" }
      }
    },

    agentStep: {
      type: "object",
      additionalProperties: false,
      required: ["run", "use", "prompt"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        run: { const: "agent" },
        use: { type: "string" },
        prompt: { type: "string" },
        cwd: { type: "string" },        // overrides agent default cwd
        session_key: { type: "string" },
        output: { type: "object" },   // free DSL — validated by compiler
        retry: { $ref: "#/$defs/retrySpec" },
        timeout: { $ref: "#/$defs/timeoutSpec" },
        on_error: {
          type: "string",
          enum: ["fail", "retry", "skip"]
        },
        policy: {
          type: "string",
          enum: ["read", "full"]
        }
      }
    },

    programStep: {
      type: "object",
      additionalProperties: false,
      required: ["run", "cmd"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        run: { const: "program" },
        cmd: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ]
        },
        env: { type: "object" },
        cwd: { type: "string" },        // overrides default cwd
        capture: { $ref: "#/$defs/captureSpec" },
        expect: { $ref: "#/$defs/expectSpec" },
        output: { type: "object" },   // free DSL
        retry: { $ref: "#/$defs/retrySpec" },
        timeout: { $ref: "#/$defs/timeoutSpec" },
        on_error: {
          type: "string",
          enum: ["fail", "retry", "skip"]
        }
      }
    },

    parallelStep: {
      type: "object",
      additionalProperties: false,
      required: ["parallel"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        parallel: {
          type: "array",
          items: { $ref: "#/$defs/parallelBranch" }
        },
        max_concurrency: {
          type: "integer",
          minimum: 1
        },
        join: {
          type: "string",
          enum: ["all", "race"]
        }
      }
    },

    parallelBranch: {
      type: "object",
      additionalProperties: false,
      required: ["id", "do"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        do: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/step" }
        }
      }
    },

    fanoutStep: {
      type: "object",
      additionalProperties: false,
      required: ["fanout"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        fanout: { $ref: "#/$defs/fanoutSpec" }
      }
    },

    fanoutSpec: {
      type: "object",
      additionalProperties: false,
      required: ["over", "do"],
      properties: {
        over: {
          oneOf: [
            { type: "string" },
            { type: "array" }
          ]
        },
        key: { type: "string" },
        max_concurrency: {
          type: "integer",
          minimum: 1
        },
        join: {
          type: "string",
          enum: ["all", "race", "quorum"]
        },
        quorum: {
          type: "integer",
          minimum: 1
        },
        success_criteria: { $ref: "#/$defs/successCriteriaSpec" },
        do: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/step" }
        }
      },
      allOf: [
        // join: quorum → quorum required
        {
          if: {
            required: ["join"],
            properties: { join: { const: "quorum" } }
          },
          then: { required: ["quorum"] }
        }
      ]
    },

    switchStep: {
      type: "object",
      additionalProperties: false,
      required: ["switch"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        switch: { $ref: "#/$defs/switchSpec" }
      }
    },

    switchSpec: {
      type: "object",
      additionalProperties: false,
      properties: {
        cases: {
          type: "array",
          items: { $ref: "#/$defs/switchCase" }
        },
        default: {
          type: "object",
          additionalProperties: false,
          properties: {
            do: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/$defs/step" }
            }
          },
          required: ["do"]
        }
      }
    },

    switchCase: {
      type: "object",
      additionalProperties: false,
      required: ["when", "do"],
      properties: {
        when: {
          oneOf: [
            { type: "string" },
            { type: "boolean" }
          ]
        },
        do: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/step" }
        }
      }
    },

    loopStep: {
      type: "object",
      additionalProperties: false,
      required: ["loop"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        loop: { $ref: "#/$defs/loopSpec" }
      }
    },

    loopSpec: {
      type: "object",
      additionalProperties: false,
      required: ["max_iterations", "do"],
      properties: {
        until: {
          oneOf: [
            { type: "string" },
            { type: "boolean" }
          ]
        },
        max_iterations: { type: "number" },
        do: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/step" }
        }
      }
    },

    guardStep: {
      type: "object",
      additionalProperties: false,
      required: ["guard"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        guard: { $ref: "#/$defs/guardSpec" }
      }
    },

    guardSpec: {
      type: "object",
      additionalProperties: false,
      required: ["when", "then", "else"],
      properties: {
        when: {
          oneOf: [
            { type: "string" },
            { type: "boolean" }
          ]
        },
        then: { $ref: "#/$defs/guardAction" },
        else: { $ref: "#/$defs/guardAction" },
        message: { type: "string" }
      }
    },

    guardAction: {
      type: "string",
      enum: ["continue", "fail", "complete"]
    },

    signalStep: {
      type: "object",
      additionalProperties: false,
      required: ["run", "prompt"],
      // Cross-field rules (timeout⇒on_timeout, on_timeout:default⇒default) are
      // enforced in the compiler so their diagnostics are not lost to oneOf
      // branch-matching noise from the shared `run:` discriminator.
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        run: { const: "signal" },
        prompt: { type: "string" },
        output: { type: "object" },   // free DSL — validated by compiler
        timeout: { type: "string" },   // duration format validated by compiler
        on_timeout: {
          type: "string",
          enum: ["fail", "default"]
        },
        default: { type: "object" }    // literal payload — validated by compiler
      }
    },

    subworkflowStep: {
      type: "object",
      additionalProperties: false,
      required: ["subworkflow"],
      properties: {
        id: {
          type: "string",
          minLength: 1,
          pattern: SAFE_AUTHOR_ID_PATTERN
        },
        subworkflow: { type: "string" },
        input: { type: "object" }     // free-form
      }
    },

    captureSpec: {
      type: "object",
      additionalProperties: false,
      required: ["from", "parse"],
      properties: {
        from: {
          type: "string",
          enum: ["stdout", "file"]
        },
        parse: {
          type: "string",
          enum: ["json", "text"]
        },
        path: { type: "string" }
      },
      allOf: [
        // from: file → path required
        {
          if: {
            required: ["from"],
            properties: { from: { const: "file" } }
          },
          then: { required: ["path"] }
        }
      ]
    },

    expectSpec: {
      type: "object",
      additionalProperties: false,
      properties: {
        exit_code: {
          type: "array",
          minItems: 1,
          items: { type: "integer", minimum: 0 }
        }
      },
      required: ["exit_code"]
    },

    retrySpec: {
      type: "object",
      additionalProperties: false,
      properties: {
        max: {
          type: "integer",
          minimum: 0
        },
        backoff: { type: "string" }    // duration format validated by compiler
      }
    },

    timeoutSpec: {
      oneOf: [
        { type: "string" },
        { type: "number", exclusiveMinimum: 0 }
      ]
    },

    successCriteriaSpec: {
      type: "object",
      additionalProperties: false,
      properties: {
        min_success: {
          type: "integer",
          minimum: 1
        }
      }
    }
  },

  // ── Top-level schema ──
  type: "object",
  additionalProperties: false,
  required: ["version", "name", "workflow"],
  properties: {
    version: {
      type: "number",
      enum: [1]
    },
    name: { type: "string" },
    description: { type: "string" },
    input: { type: "object" },        // free DSL
    agents: {
      type: "object",
      additionalProperties: {
        $ref: "#/$defs/agentSpec"
      }
    },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          items: { $ref: "#/$defs/step" }
        }
      }
    },
    outputs: {
      type: "object",
      additionalProperties: { type: "string" }
    }
  }
};
