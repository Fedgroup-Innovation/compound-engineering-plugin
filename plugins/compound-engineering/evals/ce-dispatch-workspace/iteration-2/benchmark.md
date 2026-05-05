# Benchmark: ce-dispatch

- Executor model: `anthropic/claude-opus-4.7`
- Grader model: `anthropic/claude-opus-4.7`
- Timestamp: 2026-05-05T10:01:43Z
- Runs per configuration: 1

## Summary

| Configuration | Pass rate | Time (s) | Tokens |
|---|---|---|---|
| with_skill | 1.00 ± 0.00 | 27.1 ± 0.0 | 14145 ± 0 |
| without_skill | 0.80 ± 0.00 | 14.4 ± 0.0 | 1424 ± 0 |
| **delta** | +0.2 | +12.73 | +12721.0 |

## Per-eval results

### 2-phase-4-respond-review-pr

| Config | Pass | Fail | Total | Pass rate |
|---|---|---|---|---|
| with_skill | 5 | 0 | 5 | 1.00 |
| without_skill | 4 | 1 | 5 | 0.80 |
