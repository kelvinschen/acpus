# Acpus Supervisor Knowledge

This directory owns the built-in knowledge for the DSH Acpus Supervisor. It is
not a Skill and is not loaded from `packages/cli/skills/acpus` at runtime.

The modules are written for the closed seven-tool DSH surface. They may use the
CLI Skill and executable examples as design-time references, but must translate
their guidance into DSH-native authoring, observation, and recovery behavior.
CLI commands and CLI-store assumptions do not belong here.

`pnpm --filter @acpus/dsh knowledge:build` composes the ordered modules into
`preset/acpus/agent.cordis.yml`. Run `knowledge:check` to verify that the
checked-in preset is current, and `knowledge:validate` to prepare every complete
workflow example through the Workflow Compiler.
