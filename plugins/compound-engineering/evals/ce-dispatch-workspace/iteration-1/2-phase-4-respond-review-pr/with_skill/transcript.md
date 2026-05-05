# Transcript: phase-4-respond-review-pr / with_skill

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
I'm the orchestrator. The agent in the dispatched workspace at /Users/ryan/conductor/workspaces/api-gateway/jackson just opened PR #142 against the issue we created for unit U2 of the rate-limit plan. Bring me into the dispatch respond loop. I want to review the PR. Walk me through what you would do, in order, including the exact `gh` commands.

---
Input files referenced by the prompt (rendered inline below):

(none)

```

## Assistant response

# Entering Phase 4 Respond Loop — PR Review Path

You've told me the agent (`jackson`) opened PR #142 for unit U2 of the rate-limit plan. I'll walk through exactly what I'd do, in order, as the orchestrator.

## Step 1: Present the Phase 4 menu (blocking tool)

First I'd confirm intent via the blocking question tool (`AskUserQuestion`). Since you've already said "review the PR," I'd still render the menu to stay honest to the loop, but I'd flag option 2 as the expected pick:

> **Respond loop for issue covering U2 (PR #142). What next?**
> 1. Reply to agent comment
> 2. Review the PR  ← you indicated this
> 3. Mark unit complete
> 4. Done for now

You pick **2. Review the PR**.

## Step 2: Locate and inspect the PR

Since you gave me the PR number directly, I'd skip the `gh pr list` search and go straight to viewing it. I'd run:

```bash
gh pr view 142 --json number,state,title,headRefName,baseRefName,url,body,isDraft,mergeable,author
```

I'm checking:
- `state` is `OPEN` (not already merged/closed — otherwise I'd reroute to option 3)
- `isDraft` is `false` (if draft, I'd ask whether you still want to review)
- `body` contains the `## Dispatch Result` section per the `<output-contract>` — that's where the agent reports `Status`, `Files modified`, `Issues`, `Verification`, and `Unit ID: U2`
- `headRefName` roughly matches the `expected_branch` from the issue metadata (e.g., `dispatch/U2-...`)

If I only had the issue number and not the PR number, I would have used:

```bash
gh pr list --state all --search "<issue-number> in:body" --json number,state,url,title
```

`--state all` is required because `gh pr list` defaults to open PRs only.

I'd also peek at the latest agent comment on the issue to confirm it matches the expected "PR opened, standing by" signal:

```bash
gh issue view <issue-number> --json comments --jq '.comments[-3:]'
```

Then I'd surface to you, in chat, a compact summary:
- PR title, branch, mergeable status
- The `Status` / `Verification` / `Issues` lines from the agent's `## Dispatch Result`
- A flag if anything looks off (e.g., `Status: partial`, verification not run, files list doesn't match unit U2's declared files)

## Step 3: Present the review sub-menu (blocking tool)

Per the skill's Phase 4.1 routing for option 2, I'd ask via the blocking question tool:

> **PR #142 is open. How do you want to review?**
> 1. Run `ce-code-review` now
> 2. Type feedback to post
> 3. Approve and tell user to merge
> 4. Skip (back to main menu)

## Step 4: Act on your sub-choice

### If you pick 1 — Run `ce-code-review`

I'd invoke the `ce-code-review` skill via the `Skill` tool in Claude Code, passing the PR URL (`https://github.com/<owner>/<repo>/pull/142`). That skill handles the actual review machinery. When it returns, I'd loop back to the Phase 4 main menu.

### If you pick 2 — Type feedback to post

I'd use the blocking tool to capture your free-text feedback, write it to a scratch file under `mktemp -d -t ce-dispatch-XXXXXX`, then post it as a PR review comment:

```bash
gh pr review 142 --comment --body-file /tmp/ce-dispatch-XXXXXX/pr142-feedback.md
```

Then I'd tell you:
> Review posted on PR #142. Ping jackson in Conductor: `Run /ce-resolve-pr-feedback on PR #142`.

Then loop back to the main menu.

### If you pick 3 — Approve and tell user to merge

```bash
gh pr review 142 --approve --body "Approved via ce-dispatch."
```

Then I'd tell you:
> Approved PR #142. Merge in Conductor or the GitHub UI when ready, then re-enter the loop and pick **Mark unit complete** so I can close the issue.

Then loop back to the main menu (so you can pick option 3 after merging, or option 4 to exit).

### If you pick 4 — Skip

Re-render the main Phase 4 menu.

## Step 5: Loop

The loop continues until you pick **Mark unit complete** (which runs `gh pr view 142 --json state,merged,mergedAt`, confirms `MERGED`, then `gh issue close <issue-number> --comment "Unit complete. PR merged: <pr-url>."`) or **Done for now** (which prints a summary and exits, leaving the issue and PR untouched on GitHub).

---

**Next action I need from you:** Confirm I should proceed with option 2 on the main menu, and tell me the issue number (so I can pull the latest agent comment and correlate metadata) — or confirm that PR #142's body is the only context I need and I should jump straight to the review sub-menu.
