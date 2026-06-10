/**
 * JSON Schema definition for Acpus workflow YAML specs.
 *
 * Covers structural validation: types, enums, required fields, unknown-field
 * detection (additionalProperties: false), and if/then cross-field dependencies.
 * Semantic validation (cross-references, DSL compilation, duration format)
 * remains in the hand-written compiler code.
 */

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
        env: { type: "object" },       // free-form env vars
        tools_allowlist: {
          type: "array",
          items: { type: "string" }
        },
        max_concurrency: {
          type: "integer",
          minimum: 1
        }
      },
      required: ["use"]
    },

    // ── Step (oneOf dispatch) ──
    step: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 }
      },
      oneOf: [
        { $ref: "#/$defs/agentStep" },
        { $ref: "#/$defs/programStep" },
        { $ref: "#/$defs/parallelStep" },
        { $ref: "#/$defs/fanoutStep" },
        { $ref: "#/$defs/switchStep" },
        { $ref: "#/$defs/loopStep" },
        { $ref: "#/$defs/guardStep" },
        { $ref: "#/$defs/approvalStep" },
        { $ref: "#/$defs/subworkflowStep" }
      ]
    },

    agentStep: {
      type: "object",
      additionalProperties: false,
      required: ["run", "use", "prompt"],
      properties: {
        id: { type: "string", minLength: 1 },
        run: { const: "agent" },
        use: { type: "string" },
        prompt: { type: "string" },
        session_key: { type: "string" },
        output: { type: "object" },   // free DSL — validated by compiler
        retry: { $ref: "#/$defs/retrySpec" },
        timeout: { $ref: "#/$defs/timeoutSpec" },
        on_error: {
          type: "string",
          enum: ["fail", "retry", "skip"]
        }
      }
    },

    programStep: {
      type: "object",
      additionalProperties: false,
      required: ["run", "cmd"],
      properties: {
        id: { type: "string", minLength: 1 },
        run: { const: "program" },
        cmd: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ]
        },
        env: { type: "object" },
        capture: { $ref: "#/$defs/captureSpec" },
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
        id: { type: "string", minLength: 1 },
        parallel: {
          type: "array"
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

    fanoutStep: {
      type: "object",
      additionalProperties: false,
      required: ["fanout"],
      properties: {
        id: { type: "string", minLength: 1 },
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
        do: { type: "array" }
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
        id: { type: "string", minLength: 1 },
        switch: { $ref: "#/$defs/switchSpec" }
      }
    },

    switchSpec: {
      type: "object",
      additionalProperties: false,
      properties: {
        on: { type: "string" },
        cases: {
          type: "array",
          items: { $ref: "#/$defs/switchCase" }
        },
        default: {
          type: "object",
          additionalProperties: false,
          properties: {
            do: { type: "array" }
          }
        }
      }
    },

    switchCase: {
      type: "object",
      additionalProperties: false,
      properties: {
        when: {
          oneOf: [
            { type: "string" },
            { type: "boolean" }
          ]
        },
        do: { type: "array" }
      }
    },

    loopStep: {
      type: "object",
      additionalProperties: false,
      required: ["loop"],
      properties: {
        id: { type: "string", minLength: 1 },
        loop: { $ref: "#/$defs/loopSpec" }
      }
    },

    loopSpec: {
      type: "object",
      additionalProperties: false,
      required: ["max_iterations"],
      properties: {
        until: {
          oneOf: [
            { type: "string" },
            { type: "boolean" }
          ]
        },
        max_iterations: { type: "number" },
        do: { type: "array" }
      }
    },

    guardStep: {
      type: "object",
      additionalProperties: false,
      required: ["guard"],
      properties: {
        id: { type: "string", minLength: 1 },
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

    approvalStep: {
      type: "object",
      additionalProperties: false,
      required: ["approval"],
      properties: {
        id: { type: "string", minLength: 1 },
        approval: { $ref: "#/$defs/approvalSpec" }
      }
    },

    approvalSpec: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      // A gate with no `timeout` waits indefinitely for a human decision.
      // When `timeout` is set, `on_timeout` must specify the timeout policy.
      dependencies: { timeout: ["on_timeout"] },
      properties: {
        prompt: { type: "string" },
        timeout: { type: "string" },   // duration format validated by compiler
        on_timeout: {
          type: "string",
          enum: ["fail", "escalate", "approve", "reject"]
        }
      }
    },

    subworkflowStep: {
      type: "object",
      additionalProperties: false,
      required: ["subworkflow"],
      properties: {
        id: { type: "string", minLength: 1 },
        subworkflow: { type: "string" },
        input: { type: "object" }     // free-form
      }
    },

    // ── Shared sub-schemas ──
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
