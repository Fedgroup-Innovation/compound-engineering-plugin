# Benchmark: ce-dispatch

- Executor model: `anthropic/claude-opus-4.7`
- Grader model: `anthropic/claude-opus-4.7`
- Timestamp: 2026-05-05T10:07:17Z
- Runs per configuration: 1

## Summary

| Configuration | Pass rate | Time (s) | Tokens |
|---|---|---|---|
| with_skill | 0.95 ± 0.09 | 29.2 ± 23.4 | 15035 ± 2955 |
| without_skill | 0.51 ± 0.09 | 14.3 ± 4.5 | 2036 ± 1376 |
| **delta** | +0.4389 | +14.88 | +12999.25 |

## Per-eval results

### 1-happy-path-single-unit-dispatch

| Config | Pass | Fail | Total | Pass rate |
|---|---|---|---|---|
| with_skill | 9 | 0 | 9 | 1.00 |
| without_skill | 4 | 5 | 9 | 0.44 |

### 2-phase-4-respond-review-pr

| Config | Pass | Fail | Total | Pass rate |
|---|---|---|---|---|
| with_skill | 4 | 1 | 5 | 0.80 |
| without_skill | 3 | 2 | 5 | 0.60 |

### 3-phase-4-respond-reply-to-agent-comment

| Config | Pass | Fail | Total | Pass rate |
|---|---|---|---|---|
| with_skill | 5 | 0 | 5 | 1.00 |
| without_skill | 3 | 2 | 5 | 0.60 |

### 4-phase-4-respond-mark-unit-complete

| Config | Pass | Fail | Total | Pass rate |
|---|---|---|---|---|
| with_skill | 5 | 0 | 5 | 1.00 |
| without_skill | 2 | 3 | 5 | 0.40 |
