# Transcript: phase-4-respond-reply-to-agent-comment / with_skill

## System message

```
You are a coding-agent inside Claude Code. Respond to the user's request as you would in a real session. If the request implies running shell commands (gh, bash, etc.), describe the exact commands you would run rather than executing them — this is a dry-run evaluation. Be specific and complete; do not invent capabilities you do not have. Use the `<tag>` XML structure shown by any loaded skill verbatim when rendering deliverables.

The following skill is loaded for this session and you MUST follow it:

========================================================================
SKILL: ce-dispatch (loaded for this run)
========================================================================

--- BEGIN SKILL.md ---
---
name: ce-dispatch
description: "[BETA] Dispatch a single plan implementation unit to an external agent workspace via a GitHub issue. Use after ce-plan when you already have a worktree open in Conductor (or any issue-driven workflow) and want the agent to run the compound-engineering loop end-to-end (work -> code review -> compound -> PR). Orchestrator and agent coordinate sync via issue comments and the PR; the user pings each side manually."
disable-model-invocation: true
argument-hint: "[Plan doc path. Blank to auto-detect latest plan]"
---

# Dispatch a Single Implementation Unit

Hand off **one** implementation unit from a structured plan to an **external agent workspace** (Conductor or any issue-driven workflow) by creating a single GitHub issue. The orchestrator and the agent coordinate **synchronously** via issue comments and the eventual pull request -- no polling, no automated webhooks. The user pings each side manually.

This skill is the dispatch sibling to `ce-work` and `ce-work-beta`. Where `ce-work` executes a plan in the **current** session and `ce-work-beta` can delegate to `codex exec`, `ce-dispatch` hands one unit off to a **separate workspace** and lets that workspace's agent run the standard compound-engineering loop end-to-end (work -> code review -> compound -> PR).

For background on Conductor's specific behavior (issue-to-workspace lifecycle, startup scripts, PR creation flow), see `references/conductor-notes.md`. For the structure of the prompt embedded in the issue body, see `references/dispatch-prompt-template.md`.

## Why one unit at a time?

This is the MVP shape: simple, sync, in-the-loop. Multi-unit fan-out, dependency graphs, parallel orchestration, and merge-gate enforcement belong in a future iteration. For now, every dispatch is a single GitHub issue and the user opens (or has already opened) one Conductor workspace per dispatch. The chicken-and-egg of "the worktree exists before the issue exists" is solved by **user-first ordering**: the user creates the workspace in Conductor, then invokes `ce-dispatch` from the orchestrating session and supplies the worktree path.

## Interaction Method

When asking the user a question, use the platform's blocking question tool: `AskUserQuestion` in Claude Code (call `ToolSearch` with `select:AskUserQuestion` first if its schema isn't loaded), `request_user_input` in Codex, `ask_user` in Gemini, `ask_user` in Pi (requires the `pi-ask-user` extension). Fall back to numbered options in chat only when no blocking tool exists in the harness or the call errors (e.g., Codex edit modes) -- not because a schema load is required. Never silently skip the question.

The Phase 4 respond menu has **4 options**, which fits the 4-option cap most blocking tools enforce -- always use the blocking tool for it. Earlier phases (Phase 0 plan-path confirmation, Phase 1 unit selection, Phase 3 confirm-before-creating-issue) likewise use the blocking tool.

## Input

<input_document> #$ARGUMENTS </input_document>

## Execution Workflow

### Phase 0: Input and Config Resolution

#### 0.1 Resolve the plan path

If `<input_document>` is non-empty:
- Treat it as a repo-relative path to a plan file. Verify the file exists and is readable. If not, ask the user to clarify which plan to dispatch (blocking tool, single-select from `docs/plans/*.md` candidates).

If `<input_document>` is empty:
- Auto-detect the latest plan in `docs/plans/`. Sort by file mtime descending; pick the most recently modified `*.md` whose frontmatter has `status: active`. If multiple plans tie, prefer the one whose filename matches today's or yesterday's date prefix.
- Confirm the auto-detected plan with the user via the blocking question tool before proceeding ("Dispatch from plan `<path>`? Yes / Pick another / Cancel"). Never silently dispatch the wrong plan.
- If no candidate plan exists, stop and tell the user to pass a plan path explicitly.

Resolve the plan path to a repo-relative form (relative to `git rev-parse --show-toplevel`) for use in the issue body. Repo-relative paths only -- absolute paths break across machines.

#### 0.2 Read dispatch config

Read `dispatch_*` keys from `.compound-engineering/config.local.yaml` at the repo root (use the native file-read tool -- `Read` in Claude Code, `read_file` in Codex). All keys are optional; missing values fall through to the documented defaults below.

Config keys and resolution:

| Key | Values | Default |
|---|---|---|
| `dispatch_branch_prefix` | any string (no leading/trailing slashes) | `dispatch/` |
| `dispatch_base_branch` | any branch name | repo's default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`) |
| `dispatch_labels` | comma-separated label list | `ce-dispatch` |

If a key has an unrecognized value, fall through to the default for that key. Do not error.

Store the resolved values for the rest of the workflow:
- `branch_prefix` -- used to suggest a branch name in the dispatch prompt
- `base_branch` -- recorded in the issue metadata; the in-workspace agent targets this branch with the PR
- `labels` -- list of labels applied to the created issue

Removed in this MVP: `dispatch_mode`, `dispatch_auto_review`. Mode is no longer multiplexed (one shape only); auto-review is no longer wired (the user opts in to review per PR via the Phase 4 menu).

#### 0.3 Confirm worktree path and agent name

The user must have already created a Conductor workspace (or another worktree-based workspace) for this dispatch. Without that, there is no place for the eventual agent to run.

Ask via the blocking question tool: "Paste the absolute path of the Conductor worktree you opened for this dispatch. (e.g., `/Users/you/conductor/workspaces/<repo>/<workspace-name>`)"

- The dirname of that path (the last path segment) becomes the **agent name** used in the dispatch issue body. The orchestrator and agent address each other in comments using this name (e.g., `[orchestrator -> jackson]`, `[jackson -> orchestrator]`). It is purely a label -- no infrastructure depends on it.
- If the user can't provide a worktree path, stop and tell them: "Create a Conductor workspace for this dispatch first (Cmd+Shift+N), then re-invoke `/ce-dispatch <plan-path>`." Do not invent a path.
- Do not validate the path against the orchestrator's filesystem -- the worktree typically lives outside the orchestrator's checkout and validation would always fail.

Record `worktree_path` and `agent_name` for use in Phase 2.

### Phase 1: Pick One Implementation Unit

Read the plan file. Locate the `Implementation Units` section. Each unit is a top-level bullet whose heading is `- U<N>. **<Name>**` (e.g., `- U1. **Add rate limiter**`). Capture each unit's:

- **U-ID** (e.g., `U1`, `U3`)
- **Name** (the bolded heading text)
- **Goal** (the unit's "Goal" or "Why" field)
- **Files** (the unit's `Files:` section -- Create, Modify, Read paths)
- **Patterns** (the unit's `Patterns to follow` field, if present)
- **Approach** (the unit's `Approach` field, if present)
- **Verification** (the unit's `Verification` or `Test scenarios` field)

If the plan has no recognizable Implementation Units section, stop and tell the user the plan must contain implementation units before dispatch. Do not invent units.

Presen...[truncated]
```

## User message

```
I'm the orchestrator. I just got pinged that the agent in workspace /Users/ryan/conductor/workspaces/api-gateway/jackson posted a comment on the dispatched issue (issue #87, unit U2 of the rate-limit plan) asking whether we should use Redis Cluster mode or standalone Redis for the rate-limiter backend. The decision is standalone (we already have a standalone Redis in this stack and don't want to introduce cluster mode). Help me reply via the dispatch respond loop. Include the exact `gh` command you would run.

---
Input files referenced by the prompt (rendered inline below):

(none)

```

## Assistant response

I'll walk you through the Phase 4 respond loop for this ping.

## Phase 4 — Respond menu

Per the skill, I need to present the 4-option blocking menu first. In Claude Code I'd call `AskUserQuestion` (after `ToolSearch select:AskUserQuestion` if the schema isn't loaded):

> The agent in workspace `jackson` pinged on issue #87 (U2). What would you like to do?
>
> 1. Reply to agent comment
> 2. Review the PR
> 3. Mark unit complete
> 4. Done for now

You've already told me the intent — option **1: Reply to agent comment** — so I'll route directly to 4.1's reply action.

## 4.1 — Fetch latest agent comment

First I'd pull the tail of the issue thread to confirm the ping and load full context before replying:

```bash
gh issue view 87 --json comments,body --jq '.comments[-3:]'
```

I'd scan for the most recent comment whose body starts with `**[jackson -> orchestrator]`. Assuming that's the Redis question you described, I'd surface it to you and then confirm your reply via a blocking question (`free text` / `ask a follow-up first` / `skip`). You've given me the free-text reply, so proceeding.

## Compose the reply

Formatted per the comment protocol. I'd write this to a scratch file first (per the repo's Scratch Space guidance):

```bash
SCRATCH=$(mktemp -d -t ce-dispatch-XXXXXX)
cat > "$SCRATCH/reply.md" <<'EOF'
**[orchestrator -> jackson] 2025-01-20T18:42:00Z**

Use **standalone Redis**. Do not introduce Redis Cluster mode for this unit.

Rationale:
- We already run a standalone Redis in this stack; reuse that instance for the rate-limiter backend.
- Introducing cluster mode is out of scope for U2 — it expands infra surface area and isn't required by the plan's throughput targets.
- If we later hit scaling limits that justify clustering, that's a follow-up unit with its own plan entry, not a mid-flight scope expansion on U2.

Proceed with the standalone-Redis approach described in the unit's `<approach>` section. Ping me again if anything else is ambiguous.
EOF
```

(Replace the timestamp with the actual current ISO 8601 UTC when you run it — e.g., `date -u +"%Y-%m-%dT%H:%M:%SZ"`.)

## Post the reply

The exact `gh` command:

```bash
gh issue comment 87 --body-file "$SCRATCH/reply.md"
```

## After posting

I'd tell you:

> Reply posted on issue #87. Ping the agent in Conductor (workspace `jackson` at `/Users/ryan/conductor/workspaces/api-gateway/jackson`): **"Read the new comment on issue #87 and continue."**
>
> The agent will resume U2 with standalone Redis and should eventually open a PR against the base branch. When that happens, ping me here and I'll re-render the Phase 4 menu so you can pick `Review the PR`.

Then I'd re-render the Phase 4 menu (per 4.2 — the loop doesn't complete until you pick `Mark unit complete` or `Done for now`):

> 1. Reply to agent comment
> 2. Review the PR
> 3. Mark unit complete
> 4. **Done for now** ← likely, while you wait for the agent
