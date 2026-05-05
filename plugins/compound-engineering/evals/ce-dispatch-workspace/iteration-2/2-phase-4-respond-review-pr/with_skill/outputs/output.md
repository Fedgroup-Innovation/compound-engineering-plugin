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