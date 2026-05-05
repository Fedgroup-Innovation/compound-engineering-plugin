# Dispatch Response Loop: Reviewing PR #142

Here's how I'd walk you through the review, in order.

## Step 1: Orient in the workspace

```bash
cd /Users/ryan/conductor/workspaces/api-gateway/jackson
git status
git log --oneline -10
```

This confirms we're in the right workspace and shows the branch state.

## Step 2: Identify the PR and linked issue

```bash
gh pr view 142
gh pr view 142 --json number,title,headRefName,baseRefName,body,state,isDraft,url,closingIssuesReferences
```

The `closingIssuesReferences` field confirms the PR is correctly linked to the U2 issue (so merge auto-closes it). If it isn't linked, that's the first thing to flag.

## Step 3: Re-read the unit spec and issue

```bash
# Get the issue number from the PR body / closingIssuesReferences, then:
gh issue view <U2-issue-number>
```

I want the acceptance criteria for U2 in front of me before I read a single line of code — review is against the unit spec, not against vibes.

## Step 4: Check CI state before reading diff

```bash
gh pr checks 142
gh pr view 142 --json statusCheckRollup
```

If CI is red, I surface that to you first so you can decide whether to review now or bounce it back.

## Step 5: Read the diff

```bash
gh pr diff 142
gh pr diff 142 --name-only     # file list first, for scope check
```

I'd skim file list → confirm scope matches U2 (no scope creep into U1/U3) → then read the diff. For anything non-trivial I'd also check it out locally:

```bash
gh pr checkout 142
```

## Step 6: Summarize for you

I'd then give you a compact review brief with:
- Scope match vs U2 acceptance criteria (✅/⚠️ per criterion)
- CI status
- Files changed + LOC
- Concerns / questions / suggested change requests
- My recommendation: approve, request-changes, or comment

## Step 7: You decide, I relay

Once you tell me the verdict, I post it back via the dispatched agent loop. The exact command depends on your call:

**Approve:**
```bash
gh pr review 142 --approve --body "$(cat <<'EOF'
<your approval message>
EOF
)"
```

**Request changes:**
```bash
gh pr review 142 --request-changes --body "$(cat <<'EOF'
<your change requests, itemized>
EOF
)"
```

**Inline comments on specific lines** (if you want targeted feedback rather than a top-level review body), I'd draft those and confirm wording with you before posting — `gh` supports this via `gh api` on the reviews endpoint, but it's fiddly enough I'd show you the payload first.

**Comment only (no verdict yet, just questions):**
```bash
gh pr comment 142 --body "<question>"
```

## Step 8: Close the loop with the dispatched agent

If changes are requested, the dispatched agent at that workspace picks up the review and iterates. I'd confirm they saw it:

```bash
gh pr view 142 --comments
```

---

**Proposed next action:** I run steps 1–5 and come back to you with the review brief from step 6. Want me to proceed, or do you want to adjust scope first (e.g., skip CI check, focus only on specific files)?