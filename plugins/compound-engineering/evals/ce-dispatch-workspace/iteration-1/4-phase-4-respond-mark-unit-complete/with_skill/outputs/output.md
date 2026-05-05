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