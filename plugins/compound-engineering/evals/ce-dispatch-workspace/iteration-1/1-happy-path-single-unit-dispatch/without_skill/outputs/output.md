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