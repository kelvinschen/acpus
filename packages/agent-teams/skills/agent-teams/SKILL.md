---
name: agent-teams
description: Use for dynamic parallel work with local ACP agent teams, or to inspect an existing acp-teams team; not for predefined workflows or tightly coupled work.
---

# ACP Agent Teams

`acp-teams` runs a fixed lead and independent ACP teammates in one working directory. A durable task board and mailbox coordinate runtime delegation; no workflow graph is precompiled. Assume the CLI exists; ask before installation.

## Choose it

Use it for 2–3 independently verifiable, non-overlapping workstreams. Prefer one agent when work is small, serial, or coordination-heavy.

## Operate

Own *start → delegate → integrate → verify*:

```sh
acp-teams run --agent <agent> --cwd <workspace> "<measurable goal>"
```

Put outcome, constraints, scope, and final checks in the goal; preserve user-selected agent, model, and budgets. The foreground run returns the terminal result. Use `acp-teams run --help` for options; role prompts inject commands and concrete task IDs.

For an existing team, inspect `status` once. Use `trajectory` only for a concrete failure; crashed hosts cannot resume.

## Team discipline [Mandatory]

- Lead creates a task before its owner. Each task needs one owner, disjoint scope, done criteria, and focused checks. Lead owns integration and final verification.
- Teammate reads inbox, claims the injected task ID before editing, stays within scope, then records changed files, checks, and risks in the task result.
- Task result is the authoritative handoff; do not duplicate it in messages. Message only questions, blockers, or decision-changing facts. Reminding a working member queues another ACP turn.
- Lead does available integration, then calls one blocking `wait`; never poll. After return, inspect results, run repository checks, and complete the team.
- Only lead manages teammates or completes the team. No nested teams. Never forge `ACP_TEAM_MEMBER`; inside sessions invoke `node "$ACP_TEAM_CLI"` and use `--help` for syntax.

## Safety

Members run `approve-all` and share the workspace. Use a trusted isolated directory without secrets or production credentials. Ask before destructive actions. Stop at verified or terminal state.
