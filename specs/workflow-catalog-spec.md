# Workflow Catalog Spec

## Purpose

The Workflow Catalog is the read-only discovery surface for project and global Workflow Specs that can be listed, inspected, linted, and run by CLI reference.

## Requirements

- The implementation MUST scan project Workflow Specs under `.acpus/workflows/` in the current Workspace.
- The implementation MUST scan global Workflow Specs under `$HOME/.acpus/workflows/`.
- Catalog listing MUST scan project entries before global entries.
- Catalog discovery MUST recursively consider only `*.workflow.yaml`, `*.workflow.yml`, `*.workflow.spec.yaml`, `*.workflow.spec.yml`, `workflow.yaml`, and `workflow.yml`.
- Catalog refs MUST be derived from the Workflow Spec `name` as `project:<name>` or `global:<name>`.
- Short names MUST resolve only when exactly one ready Catalog entry has that name across all scopes.
- Entries whose Workflow Spec fails static validation MUST be listed with status `invalid`.
- Entries whose otherwise valid `name` is duplicated within the same scope MUST be listed with status `conflict`.
- `workflows run` MUST accept only `ready` Catalog entries.
- `workflows list --json` and `workflows show --json` MUST expose scope, ref, name, description, input definition, input keys, path, status, and diagnostics.
- Running a global Workflow Spec MUST create the Run in the current Workspace.
- Includes and subworkflows MUST resolve relative to the Workflow Spec source path.
- Catalog source path validation and include resolution MUST use real filesystem paths after symlink resolution.
- Catalog source path validation and include resolution MUST reject targets whose real path is outside the current Workspace or `$HOME/.acpus/workflows/`.
- Catalog source path validation and include resolution MUST reject targets that do not exist or cannot be read.
- Program execution, Program `capture.path`, and default Agent cwd MUST resolve relative to the current Workspace.

## Verification

- Tests MUST cover project and global Catalog discovery.
- Tests MUST cover candidate filename filtering.
- Tests MUST cover ready, invalid, and conflict statuses.
- Tests MUST cover full refs, unique short names, and ambiguous short names.
- Tests MUST cover global Workflow Specs running in the current Workspace.
