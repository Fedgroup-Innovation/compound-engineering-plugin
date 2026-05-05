I'll walk through the dispatch as a dry-run: I'm skipping the Phase 0/1/3 blocking confirmations (plan-path confirm, unit pick, pre-create confirm) since you've already specified everything, and going straight to the rendered issue body + the exact `gh` command.

A couple of notes on what I'd normally do but am short-circuiting here:
- **Phase 0.3** — I'd confirm the worktree path via `AskUserQuestion`; you supplied `/Users/ryan/conductor/workspaces/api-gateway/jackson`, so `agent_name = jackson`.
- **Phase 0.2** — I'd `Read` `.compound-engineering/config.local.yaml`; you supplied the defaults explicitly (`dispatch/`, `main`, `ce-dispatch`), so I'm using those.
- **Phase 1** — I'd present U1/U2/U3 via blocking single-select; you picked U2.
- **Orientation paths** — In a real run I'd verify each path exists via `ls`/`Read` before including it. Below I include the paths the skill recommends; ones I can't verify in dry-run are marked with `(if present)`.

---

## Rendered issue body

I'd write this to a scratch file (`mktemp -d -t ce-dispatch-XXXXXX` → `$TMPDIR/issue-body.md`) and pass it via `--body-file`.

````markdown
<orientation>
Read these files first, before doing any work, to build context:

- `evals/files/sample-multi-unit-plan.md` — the plan this unit was extracted from
- `README.md` — repo overview
- `AGENTS.md` (if present) — repo-wide agent conventions
- `CLAUDE.md` (if present) — Claude-specific conventions, if they diverge from AGENTS.md
- `docs/architecture.md` or `docs/architecture/` (if present) — system architecture
- `services/api-gateway/src/middleware/auth.ts` — pattern to follow for middleware structure and error handling
- `services/api-gateway/src/lib/rate_limit/token_bucket.ts` — the `TokenBucket` primitive introduced by U1 (dependency); read its public surface before wiring it up
- `services/api-gateway/src/middleware/index.ts` — file you will modify
- `services/api-gateway/src/middleware/rate_limit.ts` — file you will create (read neighbors first)
- `services/api-gateway/test/middleware/rate_limit.test.ts` — file you will create (read neighboring test files for conventions)
</orientation>

<agent-identity>
- agent-name: `jackson`
- worktree-path: `/Users/ryan/conductor/workspaces/api-gateway/jackson`

Sign your comments on this issue as `[jackson -> orchestrator]`. The orchestrator will address you as `[orchestrator -> jackson]`. The label is purely for human readability — no infrastructure depends on it.
</agent-identity>

<context>
This issue corresponds to **U2** from the plan at `evals/files/sample-multi-unit-plan.md` — a small, three-unit plan adding per-user rate limiting to the `/api/v1/messages` endpoint in `services/api-gateway/`. The plan is Approved and owned by team-platform. This issue was created by `ce-dispatch` and covers a single implementation unit. Read the plan file for the full context (requirements, acceptance examples, and the other units' scope so you know where U2's boundary ends). U2 depends on U1 (the `TokenBucket` primitive) — assume U1 has landed or is landing on `main` before your PR merges.
</context>

<task>
Add a `rateLimitMiddleware` that calls `TokenBucket.consume(1)` keyed on the JWT subject claim and short-circuits with HTTP 429 + `Retry-After` when not allowed.
</task>

<files>
- Modify: `services/api-gateway/src/middleware/index.ts`
- Create: `services/api-gateway/src/middleware/rate_limit.ts`
- Create: `services/api-gateway/test/middleware/rate_limit.test.ts`
</files>

<patterns>
- `services/api-gateway/src/middleware/auth.ts` — middleware structure, error handling.
</patterns>

<approach>
- Extract the JWT subject claim from the already-validated `req.auth` context.
- Construct a `TokenBucket` keyed `rate_limit:user:<sub>` with default capacity 60 and refill 1/sec.
- On `consume()` returning `allowed: false`, write `Retry-After: <secondsUntilReset>` and return `429`.
</approach>

<constraints>
- Commit changes with conventional commit messages (e.g., `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`). One logical change per commit; squash noise locally before pushing.
- Push to a dedicated branch. The orchestrator suggests `dispatch/U2-wire-tokenbucket-into-the-api-v1-messages-middleware` in the metadata footer below — prefer that name so the orchestrator can correlate the PR back to the unit's U-ID. If the harness or workspace tool has already named the branch differently, that is fine — the U-ID in the PR body keeps correlation working.
- Open a pull request against `main` when the unit is complete. Use the in-harness PR creation flow if one is available (Conductor's `Create PR` action, the `ce-commit-push-pr` skill, etc.); otherwise `gh pr create`.
- Keep changes tightly scoped to the stated task. Do not pull adjacent refactors, renames, or cleanup into this unit — those belong in a separate unit or a follow-up issue. In particular, do **not** start on U3's per-tenant override logic; that is a separate dispatch.
- Restrict modifications to files within the repository root.
- Resolve the task fully before opening the PR. Do not stop at the first plausible implementation if verification has not passed.
- If you discover mid-execution that the unit's scope is wrong, the plan is inconsistent, or required context is missing, surface that in a new comment on this issue using the `<comment-protocol>` below — do not silently expand scope.
</constraints>

<testing>
Before writing tests, check whether the plan's test scenarios cover all categories that apply to this unit. Supplement gaps before writing tests:
- Happy path: 60 requests in 60 seconds all return 200.
- Edge cases: 61st request returns 429 with `Retry-After`; requests at exact bucket boundary; missing/malformed `sub` claim.
- Error/failure paths: Redis unavailable during `consume()`; `TokenBucket` throws; downstream middleware failure after `consume()` succeeded (does the token still count? document the decision).
- Integration: different `sub` claims have independent buckets; interaction with the existing `auth` middleware (rate-limit must run *after* auth so `req.auth.sub` is populated).

Write tests that name specific inputs and expected outcomes. This middleware sits in a chain with `auth` — verify the interaction chain works end-to-end, not just the middleware in isolation.
</testing>

<verify>
After implementing, run ALL test files together in a single command (not per-file). Cross-file contamination (e.g., mocked Redis clients or timers leaking between test files) only surfaces when tests run in the same process. If tests fail, fix the issues and re-run until they pass. Do not open the PR until verification passes — the orchestrator will not re-run verification before merging.

- `bun test services/api-gateway/test/middleware/rate_limit.test.ts`
- Plus the full `services/api-gateway` test suite: `bun test services/api-gateway` (to catch cross-file contamination).
- Manual smoke: `curl` 100 times in a tight loop against the endpoint; observe transition from 200 to 429 with `Retry-After`. Record the outcome in the PR description's `Verification` field.
</verify>

<ce-plugin>
The Compound Engineering (CE) plugin is the recommended path for this dispatch. Follow the **nine-step sequence** below. Each step is explicit so you run the full compound-engineering loop end-to-end (work → code review → compound → PR → standby for feedback).

1. **Read the orientation files** in `<orientation>` above. Build context before doing any work. Do not skip this — the orchestrator selected these files specifically.
2. **Run `/ce-work`** with `evals/files/sample-multi-unit-plan.md` passed as the argument (use the platform's skill-invocation primitive: `Skill` in Claude Code, `Skill` in Codex, the equivalent on Gemini/Pi). `ce-work` reads the plan, builds a task list scoped to **U2** only, and walks the implementation. If `ce-work` produces a task list that needs the orchestrator's input (ambiguity, missing context, scope question), STOP and use the `<comment-protocol>` to ask — do not proceed past the question.
3. **Implement and verify** per `<task>`, `<files>`, `<patterns>`, `<approach>`, `<constraints>`, `<testing>`, and `<verify>` above.
4. **Run `/ce-code-review`** against your branch before opening the PR. Address findings inline if straightforward; defer to the orchestrator via the comment protocol if a finding implies architectural change.
5. **Run `/ce-compound`** if the unit produced learnings worth capturing (a non-obvious Redis/Lua race, a middleware-ordering gotcha, a reproducible flake). Skip when there are no learnings.
6. **Run `/ce-commit-push-pr`** to commit the work, push the branch, and open the PR with an adaptive description. If `ce-commit-push-pr` is not available, fall back to `git commit && git push && gh pr create` and write the `## Dispatch Result` section by hand per `<output-contract>`.
7. **Append a comment** to this issue with the PR URL. Format: `**[jackson -> orchestrator] <ISO 8601 UTC>**\n\nPR opened: <pr-url>. Standing by for review.`
8. **Stop. Wait for orchestrator ping.** Do not poll. Do not start U3. Conductor (or the user) will surface the new orchestrator comment to you when the orchestrator replies.
9. **On orchestrator ping** with PR feedback: run `/ce-resolve-pr-feedback` on the PR. On orchestrator ping with an issue-comment clarification: re-read the issue thread, then continue. Loop until the orchestrator approves the PR.

If the CE plugin is **not** installed in this workspace, fall back to following `<task>`, `<files>`, `<patterns>`, `<approach>`, `<constraints>`, `<testing>`, and `<verify>` directly, and use `git` + `gh` for the commit/push/PR steps.
</ce-plugin>

<comment-protocol>
Use issue comments **only for clarifications** you cannot resolve from this issue body and the orientation files. Routine progress updates do not belong in comments — the PR description is the durable progress surface.

**When to comment:**
- A decision you cannot make from this issue body alone changes a public interface (e.g., the exact shape of the 429 response body).
- A decision introduces a new dependency or pattern not already in `<patterns>` or the orientation files.
- The unit's stated approach turns out to be wrong, inconsistent with the plan, or missing required context (e.g., `req.auth.sub` isn't populated where the plan assumes it is).
- Verification reveals the plan itself is wrong.

**Format:**
- Open a new comment on this issue.
- First line: `**[jackson -> orchestrator] <ISO 8601 UTC timestamp>**`
- Then a blank line, then the body. The body must include:
  1. **Question** — one or two sentences naming the decision.
  2. **What you considered** — options you evaluated and why none was obvious.
  3. **What you need from the orchestrator** — the specific input that unblocks you.

**After commenting:**
- STOP. Do not proceed past the open question. Do not start related work. Wait for an `**[orchestrator -> jackson] <timestamp>**` reply.
- On reply, re-read the full comment thread before continuing.
- If the reply does not fully unblock, ask a follow-up using the same format and stop again.

The orchestrator addresses you in the same shape: `**[orchestrator -> jackson] <ISO 8601 UTC>**` followed by the reply body.
</comment-protocol>

<output-contract>
Report the result via the **PR description**, not via a JSON file or scratch artifact — ce-dispatch reads the PR body in the Phase 4 respond loop to drive review and merge gating.

Render this section verbatim under a top-level `## Dispatch Result` heading in the PR description:

## Dispatch Result

**Status:** `completed` | `partial` | `failed`
- `completed` — all changes were made AND verification passes
- `partial` — some changes made; specifics in `Issues`
- `failed` — no meaningful progress

**Files modified:**
- list of repo-relative file paths actually changed in this PR

**Issues:**
- bullets describing any problems, gaps, scope creep avoided, or out-of-scope work the orchestrator should know about. Use `None` if there are none.

**Summary:** one short paragraph describing what was done.

**Verification:** the command(s) you ran and their outcome (e.g., `bun test -- 14 passed, 0 failed`). If verification was not possible, say why.

**Unit ID:** U2
**Plan path:** `evals/files/sample-multi-unit-plan.md`
</output-contract>

<!-- ce-dispatch-metadata
plan: evals/files/sample-multi-unit-plan.md
unit_id: U2
agent_name: jackson
worktree_path: /Users/ryan/conductor/workspaces/api-gateway/jackson
expected_branch: dispatch/U2-wire-tokenbucket-into-the-api-v1-messages-middleware
base_branch: main
labels: ce-dispatch
dispatched_at: <ISO 8601 UTC at issue-creation time, e.g. 2026-05-04T17:42:00Z>
-->
````

---

## The `gh issue create` command I would run

```bash
# 1. Write the rendered body to a per-run scratch file
SCRATCH=$(mktemp -d -t ce-dispatch-XXXXXX)
# (Write the body above to $SCRATCH/issue-body.md via the platform's file-write tool)

# 2. Create the issue
gh issue create \
  --title "[CE-Dispatch] U2: Wire TokenBucket into /api/v1/messages middleware" \
  --body-file "$SCRATCH/issue-body.md" \
  --label ce-dispatch
```

Title is 66 chars — within the ~60-char target for the goal portion after the `[CE-Dispatch] U2:` prefix.

---

## What I'd do after the issue is created (Phase 3 handoff)

I'd tell you:

> Issue `#<number>` created at `<url>`. Open the Conductor workspace at `/Users/ryan/conductor/workspaces/api-gateway/jackson` and tell the agent: `Read issue #<number> in this repo, then begin.` When jackson posts a comment back here or opens a PR, ping me in this orchestrator session and I'll bring up the Phase 4 respond menu (reply / review PR / mark complete / done for now).

A few things I'd flag to you before actually running the command, since they're real-world gotchas:

1. **Label existence** — if `ce-dispatch` doesn't yet exist as a label in the repo, `gh issue create` will warn. I'd offer once: "Label `ce-dispatch` doesn't exist. Run `gh label create ce-dispatch --color 0E8A16 --description 'Dispatched via ce-dispatch'`?"
2. **U1 dependency** — U2 depends on U1's `TokenBucket`. If U1 hasn't merged to `main` yet, jackson will be unable to import it. The skill's single-unit MVP explicitly does not gate on dependencies, so I surface this as a note in `<context>` but leave the call to you: if U1 isn't landed, you may want to dispatch U1 first (or dispatch U2 against a base branch that contains U1).
3. **`dispatched_at` timestamp** — I'd stamp this at the moment of `gh issue create`, not at prompt-rendering time.