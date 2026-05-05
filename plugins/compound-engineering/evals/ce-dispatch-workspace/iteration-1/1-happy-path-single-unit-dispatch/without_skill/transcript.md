# Transcript: happy-path-single-unit-dispatch / without_skill

## System message

```
You are a coding-agent inside Claude Code. Respond to the user's request as you would in a real session. If the request implies running shell commands (gh, bash, etc.), describe the exact commands you would run rather than executing them — this is a dry-run evaluation. Be specific and complete; do not invent capabilities you do not have. Use the `<tag>` XML structure shown by any loaded skill verbatim when rendering deliverables.
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

I'll render the dispatch issue body for unit U2 only, using the plan context and the conductor workspace you provided.

<issue_body>
# Dispatch: U2 — Wire `TokenBucket` into the `/api/v1/messages` middleware

**Parent Plan:** Add per-user rate limiting to `/api/v1/messages`
**Unit:** U2 of 3
**Owner:** team-platform
**Workspace:** `/Users/ryan/conductor/workspaces/api-gateway/jackson`
**Base branch:** `main`
**Proposed branch:** `dispatch/u2-rate-limit-middleware`

---

## Context

The `/api/v1/messages` endpoint in `services/api-gateway/` currently accepts unbounded request volume per authenticated user. Incident INC-2143 showed a single tenant exhausting the worker pool. The parent plan introduces a per-user token-bucket rate limiter persisted in Redis.

This issue dispatches **only U2**: wiring the already-built `TokenBucket` primitive (from U1) into the request middleware so excess requests short-circuit with HTTP 429.

## Scope (This Unit Only)

Add a `rateLimitMiddleware` that calls `TokenBucket.consume(1)` keyed on the JWT subject claim and short-circuits with HTTP 429 + `Retry-After` when not allowed.

**Out of scope for this unit:**
- The `TokenBucket` primitive and Lua script (U1 — assumed complete).
- Per-tenant overrides via `tenants.rate_limit_per_minute` (U3 — later).

## Requirements Addressed

- **R1.** Per-user limiting (keyed on JWT `sub` claim).
- **R2.** Default 60 req/min/user, burst 10.
- **R4.** 429 response with `Retry-After` header on excess.

## Dependencies

- **U1** (Token-bucket primitive backed by Redis) must be merged before this unit can be verified end-to-end.

## Files

- **Modify:** `services/api-gateway/src/middleware/index.ts`
- **Create:** `services/api-gateway/src/middleware/rate_limit.ts`
- **Create:** `services/api-gateway/test/middleware/rate_limit.test.ts`

## Approach

- Extract the JWT subject claim from the already-validated `req.auth` context.
- Construct a `TokenBucket` keyed `rate_limit:user:<sub>` with default capacity 60 and refill 1/sec.
- On `consume()` returning `allowed: false`, write `Retry-After: <secondsUntilReset>` and return `429`.
- Register the middleware in `src/middleware/index.ts` so it runs after auth and before the route handler.

## Patterns to Follow

- `services/api-gateway/src/middleware/auth.ts` — middleware structure and error handling conventions.

## Test Scenarios

- [ ] 60 requests in 60 seconds from the same `sub` all return 200.
- [ ] The 61st request returns 429 with a `Retry-After` header.
- [ ] Two different `sub` claims have independent buckets.

## Acceptance Examples (from parent plan)

- **AE1.** A user issuing 100 requests/min sees 60 successes followed by 40 429s with `Retry-After`.

## Verification

- [ ] `bun test services/api-gateway/test/middleware/rate_limit.test.ts` passes.
- [ ] Manual smoke: `curl` 100 times in a tight loop against `/api/v1/messages`; observe transition from 200 to 429 with `Retry-After` populated.
- [ ] `services/api-gateway/src/middleware/index.ts` registers `rateLimitMiddleware` after auth.

## Workspace Instructions

Work in the prepared Conductor workspace:

```
cd /Users/ryan/conductor/workspaces/api-gateway/jackson
git checkout -b dispatch/u2-rate-limit-middleware main
```

Open a PR against `main` when the verification checklist is complete. Reference this issue in the PR description.
</issue_body>

---

### Final `gh issue create` command

I would write the body above to a temp file first (to preserve formatting) and then run:

```bash
gh issue create \
  --title "Dispatch U2: Wire TokenBucket into /api/v1/messages middleware" \
  --label "ce-dispatch" \
  --body-file /tmp/dispatch-u2-body.md
```

Notes on what I did *not* do (dry-run):
- I did not actually call `gh issue create` or write any file.
- I did not create the `dispatch/u2-rate-limit-middleware` branch in the workspace — that's left for the agent picking up the issue.
- If your repo requires `--repo <owner>/<name>` (e.g., you're running from outside a git checkout), add that flag. I assumed invocation from within the repo.
- `ce-dispatch` must already exist as a label, or add `--label` creation via `gh label create ce-dispatch` beforehand.
