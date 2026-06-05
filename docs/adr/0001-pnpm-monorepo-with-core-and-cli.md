# pnpm monorepo with core and CLI packages

We split M1 into `@acpus/core` and `acpus` inside a pnpm monorepo so the DSL compiler can stay side-effect free while the CLI owns filesystem and process concerns. This keeps the future Temporal runtime from leaking into authoring and linting APIs.
