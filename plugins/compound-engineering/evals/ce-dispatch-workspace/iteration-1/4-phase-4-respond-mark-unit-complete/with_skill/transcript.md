# Transcript: phase-4-respond-mark-unit-complete / with_skill

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
I'm the orchestrator. PR #142 (unit U2 of the rate-limit plan, dispatched to issue #87) was just merged. Bring me into the respond loop and mark the unit complete. Include the exact `gh` commands.

---
Input files referenced by the prompt (rendered inline below):

(none)

```

## Assistant response

# Respond Loop — Resuming for Issue #87 / PR #142

You've told me the PR was merged, so I'm jumping straight into Phase 4 with option **3. Mark unit complete** pre-selected. Per the skill, I still verify the merge state before closing so we don't close an issue against an unmerged PR.

## Step 1 — Confirm the PR is actually merged

```bash
gh pr view 142 --json number,state,merged,mergedAt,mergeCommit,url
```

Expected shape:

```json
{
  "number": 142,
  "state": "MERGED",
  "merged": true,
  "mergedAt": "2025-...Z",
  "mergeCommit": { "oid": "..." },
  "url": "https://github.com/<owner>/<repo>/pull/142"
}
```

If `merged` is not `true` / `state` is not `MERGED`, I stop here and ask you to merge first before re-entering the loop. Assuming it comes back merged, I continue.

## Step 2 — Close the dispatch issue with a back-reference to the PR

```bash
gh issue close 87 \
  --comment "Unit U2 complete. PR merged: https://github.com/<owner>/<repo>/pull/142."
```

(Substitute the real PR URL captured from step 1's `.url` field.)

## Step 3 — Optional: confirm the issue is closed

```bash
gh issue view 87 --json number,state,closedAt,stateReason
```

Expecting `state: CLOSED`.

## Step 4 — Hand back to you

> Issue **#87** closed and linked to the merged PR **#142** (unit **U2**). You can archive the Conductor workspace for this dispatch now via Conductor's **Archive** action — the worktree is no longer needed.
>
> To dispatch the next unit from the rate-limit plan, re-invoke `/ce-dispatch <plan-path>` and pick the next U-ID. I won't auto-scan the plan for follow-ups — single-unit dispatch only.

## Exiting the loop

Per the skill, `Mark unit complete` is a terminal option — the Phase 4 loop exits here. No re-render of the 4-option menu. Done.
