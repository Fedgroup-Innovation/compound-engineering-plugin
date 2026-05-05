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

# Resuming the ce-dispatch Respond Loop for PR #142

You're re-entering the Phase 4 loop for the U2 dispatch. The issue and PR already exist, so I skip Phases 0–3 and go straight to the respond menu. Here is exactly what I would do, in order.

## Step 1: Re-orient — pull current state of the issue and PR

Before rendering the menu I need to know (a) which issue corresponds to U2 of the rate-limit plan, (b) the latest comment on that issue, and (c) the current state of PR #142. I would run, in order:

```bash
# Find the dispatch issue for U2 of the rate-limit plan.
# Filter by label and search the body for the unit id + plan slug.
gh issue list \
  --label ce-dispatch \
  --state open \
  --search "U2 rate-limit in:body" \
  --json number,title,url,body \
  --limit 5

# Once I have <issue-number>, grab the last few comments so I can see where
# the thread left off and confirm the agent's "PR opened" hand-off.
gh issue view <issue-number> \
  --json comments,body \
  --jq '{body: .body, last_comments: .comments[-3:]}'

# Pull PR #142 state. --state all in case it was already merged elsewhere.
gh pr view 142 \
  --json number,url,state,merged,mergedAt,headRefName,baseRefName,title,body,author,isDraft
```

From `gh issue view` I confirm the ce-dispatch metadata footer (`unit_id: U2`, `expected_branch`, `base_branch`, `agent_name: jackson`, `worktree_path: /Users/ryan/conductor/workspaces/api-gateway/jackson`) and I look for the agent's most recent comment matching `**[jackson -> orchestrator] <timestamp>**` announcing the PR.

From `gh pr view` I confirm PR #142 is `OPEN`, not a draft, and targets the expected base branch. If `state` is already `MERGED`, I would skip review and route you directly to option 3 (Mark unit complete).

I'd report a one-line summary back to you: *"Issue #N, PR #142 is OPEN, branch `dispatch/U2-...` → `main`, last agent comment at `<ts>` says PR opened and is standing by."*

## Step 2: Render the Phase 4 menu

I use the blocking question tool (`AskUserQuestion` in Claude Code — I'd call `ToolSearch` with `select:AskUserQuestion` first if its schema isn't loaded) with the four standard options:

1. Reply to agent comment
2. Review the PR
3. Mark unit complete
4. Done for now

You've already told me you want option **2. Review the PR**, so I'd pre-select it and confirm rather than make you click it a second time.

## Step 3: Route option 2 — present review sub-menu

Per the skill, option 2 has its own blocking sub-menu. I render it with these four choices:

1. Run `ce-code-review` now
2. Type feedback to post
3. Approve and tell user to merge
4. Skip

I wait for your pick. For each branch, here's exactly what I'd do:

### 3a. If you pick "Run ce-code-review now"

I invoke the `ce-code-review` skill via the platform's skill-invocation primitive (`Skill` in Claude Code), passing the PR URL returned by `gh pr view` above. I do **not** shell out to `gh pr review` in this branch — `ce-code-review` owns the review itself and will post findings through its own flow. When it returns, I re-render the Phase 4 menu so you can decide whether to type follow-up feedback, approve, or wait.

### 3b. If you pick "Type feedback to post"

I capture your free-text feedback (blocking tool, free-text response). Then:

```bash
# Write feedback to a scratch file under a per-run tmpdir, per AGENTS.md.
TMPDIR=$(mktemp -d -t ce-dispatch-XXXXXX)
cat > "$TMPDIR/review.md" <<'EOF'
<your feedback text, verbatim>
EOF

# Post as a PR review comment (not an approval, not a request-changes).
gh pr review 142 --comment --body-file "$TMPDIR/review.md"
```

Then I tell you, verbatim per the skill: *"Review posted. Ping the agent in Conductor: `Run /ce-resolve-pr-feedback on PR #142`."* And I re-render the Phase 4 menu.

### 3c. If you pick "Approve and tell user to merge"

```bash
gh pr review 142 --approve --body "Approved via ce-dispatch."
```

Then I tell you: *"Approved. Merge in Conductor / GitHub UI when ready, then re-enter the loop and pick `Mark unit complete`."* I re-render the Phase 4 menu; you'd most likely pick option 4 (Done for now) until the merge happens, then re-invoke `/ce-dispatch` to come back and close the issue.

### 3d. If you pick "Skip"

Re-render the Phase 4 menu unchanged.

## Step 4: Loop

After whichever sub-branch fires, I re-present the Phase 4 menu. The loop only ends when you pick **Mark unit complete** (which runs `gh pr view 142 --json state,merged,mergedAt`, and if `MERGED`, runs `gh issue close <issue-number> --comment "Unit complete. PR merged: <pr-url>."` and tells you to archive the `jackson` workspace) or **Done for now** (which prints a summary with issue URL, PR URL, and current state, and exits).

---

**Ready to proceed.** To actually start, I need two things I don't have yet:

1. The dispatch issue number (I'd get it from the `gh issue list` command above — if you already know it, paste it and I skip that lookup).
2. Your pick on the review sub-menu (3a / 3b / 3c / 3d).

Which review path do you want?
