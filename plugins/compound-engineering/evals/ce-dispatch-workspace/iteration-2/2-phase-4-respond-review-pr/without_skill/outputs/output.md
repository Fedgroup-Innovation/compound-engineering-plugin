# Dispatch Respond Loop — Reviewing PR #142

Here's the ordered procedure I would follow to bring you into the review loop for the agent's PR on unit U2.

## Step 1: Locate the dispatch context

First I need to confirm the workspace, the issue number for U2, and the PR metadata. I'd check the plan/state file that tracks the rate-limit units and their issue/PR mapping (typically something like a `plan.md` or dispatch state in the orchestrator workspace), then verify against GitHub.

```bash
cd /Users/ryan/conductor/workspaces/api-gateway/jackson
gh pr view 142 --json number,title,headRefName,baseRefName,state,author,body,files,additions,deletions,commits,statusCheckRollup,reviewDecision,url
```

This confirms the PR exists, which issue it closes (should reference U2's issue via `Closes #N`), and gives me diff size + CI status before I pull the contents.

## Step 2: Check CI status explicitly

```bash
gh pr checks 142
```

If checks are failing or pending, I note that — you'll likely want to wait or ask the agent to fix before you invest review time.

## Step 3: Pull the diff and changed files for your review

```bash
gh pr diff 142
gh pr view 142 --json files --jq '.files[].path'
```

I'd render the diff in the session so you can read it here, plus list the changed files so you can ask for targeted views.

## Step 4: Pull existing review activity

```bash
gh pr view 142 --comments
```

So we don't duplicate anything the agent or reviewers already said.

## Step 5: Hand control to you

At this point I stop and present you with:
- PR title, author, branch, base
- Issue it closes (U2)
- CI status summary
- File list + full diff
- Any existing comments

Then I wait for your review verdict. You'll give me one of:
- **Approve + merge** → I run `gh pr review 142 --approve --body "..."` then `gh pr merge 142 --squash --delete-branch` (or whatever merge strategy the repo uses — I'd confirm first with `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`).
- **Request changes** → I run `gh pr review 142 --request-changes --body "<your feedback>"`, and for line-level comments I'd use `gh api` against `/repos/{owner}/{repo}/pulls/142/comments` since `gh pr review` doesn't do inline comments directly. Then I dispatch the feedback back to the agent in `/Users/ryan/conductor/workspaces/api-gateway/jackson`.
- **Comment only** → `gh pr review 142 --comment --body "..."`.

## Step 6: Close the loop with the dispatched agent

After your review is posted:
- If changes requested: I send a dispatch message to the agent in its workspace summarizing the requested changes and pointing at the review URL, so it picks up the next iteration.
- If merged: I update the plan state for U2 to "done", close the issue if not auto-closed, and report which unit is next (U3).

---

**Ready to proceed?** Say the word and I'll start at Step 1. If you'd prefer I skip straight to dumping the diff, I can collapse Steps 1–4 into a single pass.