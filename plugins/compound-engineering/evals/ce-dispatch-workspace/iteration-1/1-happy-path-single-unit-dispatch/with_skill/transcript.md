# Transcript: happy-path-single-unit-dispatch / with_skill

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
I have a multi-unit plan at evals/files/sample-multi-unit-plan.md and I want to dispatch ONLY unit U2 to a Conductor workspace. The workspace I just created is at /Users/ryan/conductor/workspaces/api-gateway/jackson. Render the GitHub issue body you would create (do not actually create the issue), including all template sections, and tell me the final `gh issue create` command you would run. Use the dispatch defaults: branch prefix `dispatch/`, base branch `main`, labels `ce-dispatch`.

---
Input files referenced by the prompt (rendered inline below):

--- BEGIN evals/files/sample-multi-unit-plan.md ---
# Plan: Add per-user rate limiting to `/api/v1/messages`

**Status:** Approved
**Owner:** team-platform
**Date:** 2026-05-04

---

## Context

The `/api/v1/messages` endpoint in `services/api-gateway/` currently accepts unbounded request volume per authenticated user. We have one production incident on file (INC-2143) where a single tenant exhausted the worker pool. We want a per-user token-bucket rate limiter on this endpoint, persisted in Redis, with sensible defaults and a way to override per-tenant.

This plan is intentionally small (three units) because the change is bounded and well-understood. It is suitable for dispatch to a single Conductor workspace per unit.

## Requirements

- **R1.** Limit must be per-user (subject claim from JWT), not per-IP.
- **R2.** Default limit: 60 requests / minute / user, burst 10.
- **R3.** Per-tenant overrides via a `tenants.rate_limit` config table.
- **R4.** Excess requests respond with HTTP 429 + `Retry-After` header.

## Acceptance Examples

- **AE1.** A user issuing 100 requests/min sees 60 successes followed by 40 429s with `Retry-After`.
- **AE2.** A tenant configured with `rate_limit_per_minute: 600` does not 429 until 600/min.

---

## Implementation Units

- [ ] **U1: Token-bucket primitive backed by Redis**

  **Goal:** Implement a reusable `TokenBucket` class in `services/api-gateway/src/lib/rate_limit/` that stores per-key bucket state in Redis using `INCR + EXPIRE` semantics with atomic Lua.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Create: `services/api-gateway/src/lib/rate_limit/token_bucket.ts`
  - Create: `services/api-gateway/src/lib/rate_limit/lua/refill.lua`
  - Create: `services/api-gateway/test/lib/rate_limit/token_bucket.test.ts`

  **Approach:**
  - Implement `TokenBucket(key, capacity, refillRatePerSec)` with a `consume(n)` method returning `{ allowed, remaining, resetAt }`.
  - Use a Lua script for the atomic refill+consume to avoid race conditions across workers.
  - Use ms-precision timestamps from `Date.now()`; reject negative or zero `n`.

  **Patterns to follow:**
  - `services/api-gateway/src/lib/cache/redis_client.ts` — Redis client wrapper with retries.

  **Test scenarios:**
  - Happy path: consume 1 from a bucket of capacity 10 returns `{ allowed: true, remaining: 9 }`.
  - Burst: consume 11 from a bucket of capacity 10 returns `allowed: false`.
  - Refill: after `refillRatePerSec * 1000`ms, the bucket replenishes one token.

  **Verification:**
  - `bun test services/api-gateway/test/lib/rate_limit/token_bucket.test.ts` passes.
  - Lua script can be loaded into Redis without syntax errors.

---

- [ ] **U2: Wire `TokenBucket` into the `/api/v1/messages` middleware**

  **Goal:** Add a `rateLimitMiddleware` that calls `TokenBucket.consume(1)` keyed on the JWT subject claim and short-circuits with HTTP 429 + `Retry-After` when not allowed.

  **Requirements:** R1, R2, R4

  **Dependencies:** U1

  **Files:**
  - Modify: `services/api-gateway/src/middleware/index.ts`
  - Create: `services/api-gateway/src/middleware/rate_limit.ts`
  - Create: `services/api-gateway/test/middleware/rate_limit.test.ts`

  **Approach:**
  - Extract the JWT subject claim from the already-validated `req.auth` context.
  - Construct a `TokenBucket` keyed `rate_limit:user:<sub>` with default capacity 60 and refill 1/sec.
  - On `consume()` returning `allowed: false`, write `Retry-After: <secondsUntilReset>` and return `429`.

  **Patterns to follow:**
  - `services/api-gateway/src/middleware/auth.ts` — middleware structure, error handling.

  **Test scenarios:**
  - 60 requests in 60 seconds all return 200.
  - 61st request returns 429 with `Retry-After`.
  - Different `sub` claims have independent buckets.

  **Verification:**
  - `bun test services/api-gateway/test/middleware/rate_limit.test.ts` passes.
  - Manual: `curl` 100 times in a tight loop; observe transition from 200 to 429.

---

- [ ] **U3: Per-tenant override via `tenants.rate_limit_per_minute`**

  **Goal:** Look up the tenant's `rate_limit_per_minute` override (if set) before constructing the `TokenBucket`. Falls back to the default when no override is present.

  **Requirements:** R3

  **Dependencies:** U2

  **Files:**
  - Modify: `services/api-gateway/src/middleware/rate_limit.ts`
  - Create: `services/api-gateway/src/lib/tenant/rate_limit_lookup.ts`
  - Modify: `services/api-gateway/test/middleware/rate_limit.test.ts`

  **Approach:**
  - Add `getRateLimitForTenant(tenantId)` that reads from the existing `tenants` table and caches results for 60s.
  - In `rateLimitMiddleware`, look up the limit from the JWT's `tenant_id` claim and pass to `TokenBucket`.
  - Add a fixture tenant with override `600/min` to the middleware tests; assert it does not 429 until 600/min.

  **Patterns to follow:**
  - `services/api-gateway/src/lib/tenant/feature_flags.ts` — same lookup-and-cache pattern.

  **Test scenarios:**
  - Tenant without override: 60/min default applies.
  - Tenant with `rate_limit_per_minute: 600` override: 600/min applies.
  - Override changes mid-flight: takes effect after the 60s cache TTL.

  **Verification:**
  - `bun test services/api-gateway/test/middleware/rate_limit.test.ts` passes (including override fixtures).
  - Manual: change a tenant's override in the DB, wait 60s, verify new limit takes effect.

--- END evals/files/sample-multi-unit-plan.md ---

```

## Assistant response

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
