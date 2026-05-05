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