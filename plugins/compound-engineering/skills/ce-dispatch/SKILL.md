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

Present the captured units to the user via the blocking question tool (single-select). Each option is `<U-ID>: <Name>`. The user picks **one**. Multi-unit fan-out is intentionally out of scope for this MVP.

This MVP does not build a dependency graph and does not run a parallel-safety check -- only one unit is in flight per `ce-dispatch` invocation. If the user wants to dispatch a second unit while the first is still open, they invoke `ce-dispatch` again separately.

### Phase 2: Generate the Dispatch Prompt

For the selected unit, render a self-contained prompt using the template in `references/dispatch-prompt-template.md`. Load that file now and follow its required structure.

Substitute concrete values for every section:

- `<orientation>` -- a checklist of repo-relative paths the in-workspace agent should `Read` first, before doing any work. Include (only those that exist in the target repo):
  - the plan file (the unit was extracted from it)
  - `README.md`
  - `AGENTS.md` and/or `CLAUDE.md` (root and any plugin-scoped equivalents)
  - any `docs/architecture.md`, `docs/architecture/`, or top-level architecture document
  - the unit's `Patterns to follow` files (verbatim from the unit)
  - the unit's `Files:` paths (so the agent reads existing code before editing)
  This is **progressive context exposure**: list paths, do not inline content. The agent reads what it needs.
- `<agent-identity>` -- the `agent_name` (worktree dirname from Phase 0.3) and the `worktree_path` (absolute path the user supplied). The agent uses `agent_name` to sign comments; the orchestrator uses it to address the agent.
- `<context>` -- one paragraph orienting the agent: plan path (repo-relative), one-sentence project context (read from plan frontmatter or repo README), note that this issue was created by `ce-dispatch` and corresponds to a single unit.
- `<task>` -- the unit's Goal, verbatim.
- `<files>` -- the unit's combined Create/Modify/Read file list, repo-relative.
- `<patterns>` -- the unit's `Patterns to follow` content, or the fallback line `"No explicit patterns referenced -- follow existing conventions in the modified files."`
- `<approach>` -- the unit's Approach, verbatim.
- `<constraints>` -- the template's constraints block, unchanged.
- `<testing>` -- the template's testing guidance, anchored to this unit's test scenarios.
- `<verify>` -- the project's combined test/lint commands (read from the plan or from the repo's package manifest).
- `<ce-plugin>` -- the template's explicit nine-step compound-engineering loop, unchanged.
- `<comment-protocol>` -- the template's comment-protocol block, unchanged.
- `<output-contract>` -- the template's PR-description schema, unchanged.

After the rendered XML body, append the metadata HTML comment from the template, populated with:
- `plan: <repo-relative plan path>`
- `unit_id: <e.g. U3>`
- `agent_name: <worktree dirname>`
- `worktree_path: <absolute path>`
- `expected_branch: <branch_prefix><U-ID>-<slugged-unit-name>` (e.g., `dispatch/U3-add-rate-limiter`)
- `base_branch: <resolved base_branch>`
- `labels: <resolved labels list>`
- `dispatched_at: <ISO 8601 UTC>`

Single-unit dispatch only -- there is no multi-unit coalescing in this MVP. `dependencies:` is intentionally not part of the metadata in the single-unit shape; the orchestrator does not gate merges on dependencies in this iteration.

### Phase 3: Create the Issue

Before creating the issue, present the dispatch summary to the user via the blocking question tool: U-ID and goal, agent name and worktree path, the labels that will be applied, and the base branch. Options: `Create the issue`, `Edit metadata`, `Cancel`. Default to `Create the issue` when the user picks it explicitly.

```bash
gh issue create \
  --title "[CE-Dispatch] <U-ID>: <unit goal, trimmed to ~60 chars>" \
  --body-file <rendered prompt path> \
  --label <comma-separated labels>
```

Notes:
- Write the rendered prompt to a per-run scratch file under `mktemp -d -t ce-dispatch-XXXXXX` (per the repo's "Scratch Space" guidance in `AGENTS.md`).
- The label list comes from `dispatch_labels` (default `ce-dispatch`). If a label does not yet exist in the repo, `gh` prints a warning -- surface it to the user once and offer to create the label via `gh label create` (single confirmation).
- After successful issue creation, capture and store the issue URL and number for the Phase 4 loop.
- If `gh issue create` fails (auth error, rate limit, etc.), stop and surface the error. Do not retry blindly -- the user needs to fix the underlying problem.

After the issue is created, tell the user: "Issue `#<number>` created at `<url>`. Open the Conductor workspace at `<worktree_path>` and tell the agent: `Read issue #<number> in this repo, then begin.` When the agent posts a comment back here or opens a PR, ping me in this orchestrator session and I'll respond via the Phase 4 menu."

### Phase 4: Respond Loop

This phase is an **interactive loop**. Each iteration the orchestrator presents the user with a four-option menu via the blocking question tool. The user picks an option (or describes what they want in free text); the orchestrator acts; the loop repeats until the user picks `Done for now` or the unit is marked complete.

The four options:

1. **Reply to agent comment** -- read the issue thread, surface the latest agent-to-orchestrator comment, capture the user's reply in the orchestrator session (full context loaded), and post the reply back via `gh issue comment`.
2. **Review the PR** -- the agent has opened a PR; pull it and either invoke `ce-code-review` against it, or capture user-typed feedback and post it as a PR review comment via `gh pr review`.
3. **Mark unit complete** -- the PR has been merged (manually, by the user, in Conductor or the GitHub UI); close the issue and tell the user to archive the Conductor workspace.
4. **Done for now** -- exit the loop; the issue and PR persist. The user can re-invoke `/ce-dispatch <plan-path>` later to resume the loop.

#### 4.1 Routing

Act on the user's selection -- do not just announce it. The bare per-option action lives inline below.

- **Reply to agent comment (1)** -- run `gh issue view <issue-number> --json comments,body --jq '.comments[-3:]'` to fetch the latest comments (or pull more if context is missing). Identify the latest comment whose body matches the agent-to-orchestrator comment-protocol shape (`[<agent_name> -> orchestrator]`). Show the question to the user. Capture the user's reply via the blocking question tool ("free text" / "ask a follow-up first" / "skip"). If `free text`, format the reply as `**[orchestrator -> <agent_name>] <ISO 8601 UTC>**\n\n<user reply text>` and post via `gh issue comment <issue-number> --body-file <scratch>`. After posting, tell the user: "Reply posted. Ping the agent in Conductor: `Read the new comment on issue #<number> and continue.`"

- **Review the PR (2)** -- run `gh pr list --state all --search "<issue-number> in:body"` (or `gh pr view <pr-number>` if the user supplied it). `--state all` is required because `gh pr list` defaults to open PRs only and would otherwise miss a PR merged elsewhere. If a PR is found and is `OPEN`, ask the user (blocking tool): `Run ce-code-review now / Type feedback to post / Approve and tell user to merge / Skip`.
  - `Run ce-code-review` -- invoke the `ce-code-review` skill via the platform's skill-invocation primitive (`Skill` in Claude Code, `Skill` in Codex, the equivalent on Gemini/Pi), passing the PR URL.
  - `Type feedback to post` -- capture user-typed feedback, post via `gh pr review <pr-number> --comment --body-file <scratch>`. Tell the user: "Review posted. Ping the agent in Conductor: `Run /ce-resolve-pr-feedback on PR #<pr-number>`."
  - `Approve and tell user to merge` -- post `gh pr review <pr-number> --approve --body "Approved via ce-dispatch."` Tell the user: "Approved. Merge in Conductor / GitHub UI when ready, then re-enter the loop and pick `Mark unit complete`."
  - `Skip` -- re-render the menu.

- **Mark unit complete (3)** -- run `gh pr view <pr-number> --json state,merged,mergedAt`. If the PR state is `MERGED`, run `gh issue close <issue-number> --comment "Unit complete. PR merged: <pr-url>."` Tell the user: "Issue `#<number>` closed. You can archive the Conductor workspace at `<worktree_path>` now (Conductor's Archive action)." Exit the loop. If the PR is not merged yet, tell the user to merge first and re-enter the loop.

- **Done for now (4)** -- print a summary (issue URL, PR URL if open, current state) and exit the loop. The dispatched issue and PR persist on GitHub; the user can re-invoke `ce-dispatch` later to resume.

If the user enters free text instead of a number, interpret intent and route to the closest option, or ask one clarifying question and resume the loop.

#### 4.2 Completion

The skill is **not** complete until the user picks `Done for now` or `Mark unit complete`. Re-rendering the menu and stopping at the user's selection without acting on it is not completion -- fire the routed action.

When the unit is marked complete, congratulate the user briefly and exit. Do not auto-rescan the plan for follow-up units -- multi-unit dispatch is out of scope; the user invokes `ce-dispatch` again for the next unit.

## Pipeline Mode

If `ce-dispatch` is invoked from an automated workflow (e.g., LFG, or any `disable-model-invocation` upstream), skip the Phase 4 interactive loop and return immediately after Phase 3 with a structured summary of the dispatched unit (issue URL, agent name, worktree path, expected branch). The caller decides what to do next.

## What ce-dispatch does NOT do

- It does not programmatically create Conductor workspaces. The user creates the workspace before invoking the skill (see Phase 0.3).
- It does not write to or modify the dispatched workspace's filesystem. The orchestrating session only touches GitHub via `gh` and the local plan file.
- It does not edit the plan file. Plan mutations are `ce-plan`'s job; execution progress lives in git, the GitHub issue thread, and the resulting PR.
- It does not run a long-running background poller or webhook. The Phase 4 menu refreshes only when the user re-enters it.
- It does not fan out multiple units, build a dependency graph, or gate merges on dependency order. One unit per dispatch; the user invokes `ce-dispatch` again for the next unit.
- It does not auto-merge PRs or run the project's test suite after merge. The user merges manually (in Conductor or the GitHub UI) and re-enters the loop with `Mark unit complete`.
