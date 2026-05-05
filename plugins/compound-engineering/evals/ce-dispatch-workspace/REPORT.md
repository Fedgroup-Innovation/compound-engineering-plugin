# Battle-test report: `ce-dispatch` (single-unit sync MVP)

**Skill under test:** `plugins/compound-engineering/skills/ce-dispatch/` (rewrite from PR #4)
**Date:** 2026-05-04
**Framework:** Anthropic skill-creator eval protocol (https://github.com/anthropics/skills/tree/main/skills/skill-creator)
**Executor model:** `anthropic/claude-opus-4.7` (resolved to `claude-4.7-opus-20260416`, served via Bedrock through OpenRouter)
**Grader model:** `anthropic/claude-opus-4.7`
**Runner:** `evals/scripts/run_eval_pack.py` (Path-A: direct OpenRouter; mimics skill-creator's eval protocol — system+user prompt with skill loaded vs. baseline, JSON-graded against quantitative expectations, aggregated to `benchmark.json`)

## TL;DR

The skill provides a large, discriminating lift over the no-skill baseline on every test prompt. After one round of eval-design refinement, **with-skill passes 24/24 expectations across 4 prompts**. The remaining gap to baseline is `+44 pp` (95% → 51% iteration-1, then 100% on the refined eval-2 in iteration-2).

| Configuration | Pass rate (24 expectations across 4 evals) |
|---|---|
| `with_skill` | **100% (24/24)** after iteration-2 assertion fix; **95% (23/24)** in iteration-1 |
| `without_skill` baseline | 51% iteration-1 / 56% with iteration-2 fix |
| **delta** | **+44 to +49 pp** |

## Evals run

Four prompts cover the four meaningful skill surfaces of the MVP rewrite:

| ID | Name | Surface tested | Iter-1 result |
|---|---|---|---|
| 1 | `happy-path-single-unit-dispatch` | Phase 0–3: orientation + agent-identity + comment-protocol + ce-plugin block + metadata footer + single `gh issue create` | **9/9 (100%)** vs. 4/9 baseline |
| 2 | `phase-4-respond-review-pr` | Phase 4 four-option menu + PR-review routing | 4/5 (80%) iter-1 → **5/5 (100%) iter-2** vs. 3/5 → 4/5 baseline |
| 3 | `phase-4-respond-reply-to-agent-comment` | Phase 4 + `[orchestrator -> agent] <ts>` comment-protocol prefix on reply | **5/5 (100%)** vs. 3/5 baseline |
| 4 | `phase-4-respond-mark-unit-complete` | Phase 4 + `gh issue close` + worktree archival prompt + PR-state verification gate | **5/5 (100%)** vs. 2/5 baseline |

Eval pack lives at `plugins/compound-engineering/skills/ce-dispatch/evals/evals.json` (per Anthropic's expected layout, co-located with the skill).

## Findings

### Skill-level

No skill bugs surfaced. The skill correctly:

- Renders all six required prompt-template sections (`<orientation>`, `<agent-identity>`, `<comment-protocol>`, `<ce-plugin>`, `<output-contract>`, metadata footer) with the exact shapes the contract test enforces.
- Scopes content from the correct unit when picking U2 of a multi-unit plan (does not bleed in U1 or U3 content).
- Surfaces exactly four Phase 4 options (no six-option monitor menu, no dependency graph, no auto-review).
- Routes review work through `/ce-code-review` via the platform's skill-invocation primitive rather than inlining a fresh review prompt.
- Uses `gh pr list --state all` consistently, preventing the "merged PRs are invisible" footgun.
- Uses the `[orchestrator -> <agent-name>] <ISO 8601 UTC>` prefix shape for replies, matching the comment-protocol the dispatched prompt expects.
- Verifies PR is in `MERGED` state (via `gh pr view --json state`) before closing the issue, instead of trusting the user's word.
- Tells the user to archive the Conductor workspace manually rather than attempting to do it itself.

### Eval-pack-level

Round 1 surfaced one eval design issue (caught by the grader's `eval_feedback`, exactly as Anthropic's process intends):

- **Eval 2, expectation 2** prescribed `gh pr diff <number>` even when the agent delegated review to `/ce-code-review`. The agent's behavior (delegating the diff fetch to the sub-skill) was correct; the assertion was over-specified.
- **Fix applied in iteration-2:** loosened to "if delegating to `/ce-code-review`, direct `gh pr diff` is optional; if inspecting itself, it remains required."
- **Iteration-2 result on the refined assertion:** 5/5 with-skill, 4/5 baseline. The grader's `eval_feedback` confirms: *"Expectations are clear and well-targeted at the common failure modes; the output cleanly satisfied all of them."*

### What this method does and does not test

**Tests (well, with strong signal):**
- Skill prose correctness — does the agent produce the right structure, in the right order, with the right routing decisions, when the skill is loaded.
- Discrimination — does loading the skill genuinely change behavior compared to a vanilla agent. Yes: +44 to +49 pp across the pack.
- Eval design — the grader's `eval_feedback` flags assertions that pass for the wrong reasons.

**Does not test:**
- Real tool use. The runner is single-shot Chat Completions; the agent describes commands rather than executing them. The contract test (`tests/skills/ce-dispatch-contract.test.ts`, 63 cases) covers the actual loader/template-render path.
- Multi-turn conversation across the comment protocol (asking for clarification → STOPping → resuming on reply). Would require multiple linked LLM calls; out of scope for this round.
- Real `gh issue create`/`gh issue close`/`gh pr view` execution. The agent surfaces commands; verifying they actually work end-to-end requires live GitHub credentials and a real Conductor workspace, which is the user's manual end-to-end test plan in PR #4.

## Cost

| Phase | Tokens | Cost (USD) |
|---|---|---|
| Iteration 1 (8 executor + 8 grader runs) | ~135 k | ~$1.20 |
| Iteration 2 (2 executor + 2 grader runs, eval-2 only) | ~30 k | ~$0.30 |
| **Total** | **~165 k** | **~$1.50** |

Well under my pre-flight estimate of $7–20.

## How to reproduce

```bash
# From repo root, on branch mvp/ce-dispatch-evals:
export OPENROUTER_API_KEY=<your-key>

# Run the full pack (iteration-1):
python3 plugins/compound-engineering/skills/ce-dispatch/evals/scripts/run_eval_pack.py

# Run a single eval, e.g. after iterating evals.json:
python3 plugins/compound-engineering/skills/ce-dispatch/evals/scripts/run_eval_pack.py --iteration 2 --eval-id 2

# Substitute a different model:
python3 plugins/compound-engineering/skills/ce-dispatch/evals/scripts/run_eval_pack.py --executor-model anthropic/claude-sonnet-4.5

# Dry-run (no API calls; renders prompts only):
python3 plugins/compound-engineering/skills/ce-dispatch/evals/scripts/run_eval_pack.py --dry-run
```

Outputs land at `plugins/compound-engineering/evals/ce-dispatch-workspace/iteration-<N>/`. The runner produces, per-run, the `eval_metadata.json`, `outputs/output.md`, `outputs/metrics.json`, `transcript.md`, `transcript-raw.json`, `timing.json`, and `grading.json` files specified by Anthropic's `references/schemas.md`. Per-iteration aggregates land at `iteration-<N>/benchmark.json` and `benchmark.md`.

## Conclusion

**PR #4 is ready for review.** The MVP rewrite produces structurally correct, discriminating output across all four meaningful skill surfaces, with no signal that further skill changes are needed. The remaining validation step is the user's manual end-to-end test in a real Conductor workspace, which only the user can drive.
