# Agent Executor Spec

## Purpose

`@acpus/agent-executor` executes concrete agent requests for runtime consumers. It supports deterministic mock requests and command-backed requests with retry, timeout, output parsing, output caps, and provider command environment parsing. It does not own workflow scheduling, prompt rendering, schema validation, or durable runtime state.

## Requirements

### Public API

- The package MUST expose `executeAgentRequest(request)`.
- The package MUST expose `getProviderCommandFromEnv(use, env?)`.
- The package MUST expose `AgentProviderRequiredError`.
- The package MUST expose public agent execution request types.
- The package MUST NOT expose a binary.

### Mock Requests

- Mock requests MUST parse the supplied prompt deterministically.
- Empty mock output MUST produce an empty object.
- JSON prompt output MUST parse as JSON when possible.
- Non-JSON mock output MUST produce a text envelope.
- `acceptOutput`, when supplied, MUST receive the parsed mock output before it is returned.

### Command Requests

- Command-backed requests MUST run the configured command in the requested working directory.
- Command-backed requests MUST merge provided environment variables with `ACPUS_AGENT_PROMPT` and `ACPUS_AGENT_ATTEMPT`.
- Command-backed requests MUST attempt execution up to `maxAttempts`, with a minimum of one attempt.
- Non-zero command exit codes MUST fail the attempt.
- Invalid output rejected by `acceptOutput` MUST fail the attempt and allow retry while attempts remain.
- Successful command stdout MUST parse as JSON when possible and fall back to a text envelope otherwise.
- Empty successful stdout MUST parse as an empty object.
- Combined stdout/stderr output above the package output cap MUST terminate the command and fail the request.
- Command timeout MUST terminate the spawned process group and fail the request.
- After all attempts fail, `executeAgentRequest(...)` MUST throw the last failure.

### Provider Command Environment

- `getProviderCommandFromEnv(use, env?)` MUST parse `ACPUS_AGENT_PROVIDER_COMMANDS` as a JSON object.
- Missing provider command environment MUST return `undefined`.
- Malformed provider command JSON MUST throw.
- Provider command values MUST be non-empty strings.

## Verification

- Public API contract tests MUST cover exported runtime keys.
- Type tests MUST cover public request and error types.
- Integration tests MUST cover mock execution, command execution, retry on invalid output, timeout termination, output cap failure, and provider command environment parsing.
