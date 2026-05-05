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
