#!/usr/bin/env python3
"""Battle-test the `ce-dispatch` skill against Anthropic's skill-creator eval framework
via direct OpenRouter calls (Opus 4.7 by default).

This is a Path-A runner: it implements skill-creator's eval *protocol* (with-skill
vs baseline subagent runs, grader subagent, per-eval grading.json, aggregate
benchmark.json) without depending on Claude Code's `Task` tool or the `claude` CLI.

Layout produced (sibling to skills/, inside the plugin root):

    plugins/compound-engineering/evals/ce-dispatch-workspace/iteration-<N>/
      <eval_name>/
        eval_metadata.json
        with_skill/
          outputs/output.md          # the model's response
          outputs/metrics.json       # tool-call counts (always 0 here; we don't run tools)
          transcript.md
          timing.json
          grading.json
          user_notes.md (optional)
        without_skill/
          outputs/output.md
          outputs/metrics.json
          transcript.md
          timing.json
          grading.json
      benchmark.json
      benchmark.md

Usage:
    python -m scripts.run_eval_pack                     # iteration-1, 1 run/config
    python -m scripts.run_eval_pack --iteration 2       # next iteration
    python -m scripts.run_eval_pack --runs 3            # 3 runs/config (more stable means)
    python -m scripts.run_eval_pack --eval-id 1         # only eval id 1
    python -m scripts.run_eval_pack --skip-without-skill  # only with_skill (cheaper)
    python -m scripts.run_eval_pack --executor-model anthropic/claude-sonnet-4.5
    python -m scripts.run_eval_pack --dry-run           # don't call API; render prompts only

Requires env var:
    OPENROUTER_API_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, pstdev
from typing import Any

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
SKILL_DIR = Path(__file__).resolve().parents[2]   # .../skills/ce-dispatch/
PLUGIN_SKILLS_DIR = SKILL_DIR.parent              # .../skills/
PLUGIN_DIR = PLUGIN_SKILLS_DIR.parent             # .../compound-engineering/
# Workspace lives outside skills/ so the skill-prefix scanner doesn't treat it
# as a malformed skill directory. Sibling-to-skill is preserved at the plugin
# level: PLUGIN_DIR/evals/ce-dispatch-workspace/.
WORKSPACE_DIR = PLUGIN_DIR / "evals" / "ce-dispatch-workspace"
EVALS_FILE = SKILL_DIR / "evals" / "evals.json"

DEFAULT_EXECUTOR_MODEL = "anthropic/claude-opus-4.7"
DEFAULT_GRADER_MODEL = "anthropic/claude-opus-4.7"

# References to load alongside SKILL.md when running with-skill.
# Conductor-notes is excluded — it's a per-platform extension that doesn't ship in the
# default dispatch behavior. Including it would inflate token counts without testing
# core skill prose.
SKILL_FILES_TO_INCLUDE = [
    "SKILL.md",
    "references/dispatch-prompt-template.md",
]


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def load_skill_bundle() -> str:
    """Render the skill content the way Claude Code would expose it to a subagent.

    Mirrors skill-creator's "Skill path: <path>" pattern: it gives the executor the
    full SKILL.md plus the references the skill body references, so the executor sees
    the same context it would see when the skill is loaded in-session.
    """
    parts: list[str] = []
    parts.append("=" * 72)
    parts.append("SKILL: ce-dispatch (loaded for this run)")
    parts.append("=" * 72)
    parts.append("")
    for rel in SKILL_FILES_TO_INCLUDE:
        path = SKILL_DIR / rel
        parts.append(f"--- BEGIN {rel} ---")
        parts.append(read_text(path))
        parts.append(f"--- END {rel} ---")
        parts.append("")
    return "\n".join(parts)


def load_eval_files(eval_def: dict[str, Any]) -> str:
    """Render referenced eval input files inline (best-effort, with file labels)."""
    files = eval_def.get("files") or []
    if not files:
        return "(none)"
    parts: list[str] = []
    for rel in files:
        path = SKILL_DIR / rel
        if not path.exists():
            parts.append(f"[MISSING FILE: {rel}]")
            continue
        parts.append(f"--- BEGIN {rel} ---")
        parts.append(read_text(path))
        parts.append(f"--- END {rel} ---")
    return "\n".join(parts)


def build_executor_messages(
    eval_def: dict[str, Any],
    *,
    with_skill: bool,
) -> list[dict[str, str]]:
    """Construct the chat messages for an executor run.

    With-skill: prepend the skill bundle to the system message.
    Without-skill: bare system + user.
    """
    eval_files_block = load_eval_files(eval_def)
    base_system = (
        "You are a coding-agent inside Claude Code. Respond to the user's request "
        "as you would in a real session. If the request implies running shell "
        "commands (gh, bash, etc.), describe the exact commands you would run rather "
        "than executing them — this is a dry-run evaluation. Be specific and "
        "complete; do not invent capabilities you do not have. Use the `<tag>` XML "
        "structure shown by any loaded skill verbatim when rendering deliverables."
    )

    if with_skill:
        system = (
            f"{base_system}\n\n"
            f"The following skill is loaded for this session and you MUST follow it:\n\n"
            f"{load_skill_bundle()}"
        )
    else:
        system = base_system

    user_content = (
        f"{eval_def['prompt']}\n\n"
        f"---\n"
        f"Input files referenced by the prompt (rendered inline below):\n\n"
        f"{eval_files_block}\n"
    )

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]


def build_grader_messages(
    eval_def: dict[str, Any],
    output_text: str,
) -> list[dict[str, str]]:
    """Construct grader messages: one per expectation, structured JSON output expected."""
    expectations = eval_def["expectations"]
    expectations_block = "\n".join(f"- [{i}] {a}" for i, a in enumerate(expectations))
    system = (
        "You are the grader subagent for an Anthropic skill-creator eval. Your job is "
        "to evaluate a list of EXPECTATIONS against a TRANSCRIPT/OUTPUT and decide, "
        "for each, whether it PASSES or FAILS, citing concrete evidence from the "
        "output. Be strict: an expectation only passes when the output clearly and "
        "concretely satisfies it. Surface-level compliance (e.g., a section heading "
        "exists but is empty) is a fail.\n\n"
        "Return ONLY valid JSON in exactly this shape (no markdown, no commentary):\n"
        "{\n"
        '  "expectations": [\n'
        '    {"text": "<expectation text>", "passed": true|false, "evidence": "<quoted snippet or specific reference>"}\n'
        "  ],\n"
        '  "summary": {"passed": <int>, "failed": <int>, "total": <int>, "pass_rate": <float 0-1>},\n'
        '  "eval_feedback": {"suggestions": [], "overall": "<short critique of the eval design itself, optional>"}\n'
        "}\n\n"
        "The expectations list MUST be returned in the SAME ORDER as supplied to you, "
        "with the text field copied verbatim."
    )

    user_content = (
        f"# EXPECTATIONS\n\n"
        f"{expectations_block}\n\n"
        f"# OUTPUT (the agent's response to the eval prompt)\n\n"
        f"{output_text}\n\n"
        f"# TASK\n\n"
        f"Grade each expectation. Return the JSON described in the system prompt."
    )

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]


def call_openrouter(
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 8000,
    temperature: float = 0.0,
    timeout: int = 600,
) -> dict[str, Any]:
    """POST /chat/completions; return parsed JSON."""
    body = json.dumps(
        {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        OPENROUTER_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # OpenRouter recommends these for usage analytics:
            "HTTP-Referer": "https://github.com/Fedgroup-Innovation/compound-engineering-plugin",
            "X-Title": "ce-dispatch skill battle test (skill-creator-style)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter HTTPError {e.code}: {body_text}") from e


def extract_text(resp: dict[str, Any]) -> str:
    return resp["choices"][0]["message"]["content"]


def extract_usage(resp: dict[str, Any]) -> dict[str, Any]:
    return resp.get("usage", {})


def slugify(s: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in s).strip("-")


def write_run_artifacts(
    run_dir: Path,
    *,
    eval_def: dict[str, Any],
    config_label: str,
    messages: list[dict[str, str]],
    response_text: str,
    usage: dict[str, Any],
    started_at: str,
    ended_at: str,
    duration_seconds: float,
) -> None:
    outputs_dir = run_dir / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)

    # Save the model's full response as the primary output artifact.
    (outputs_dir / "output.md").write_text(response_text, encoding="utf-8")

    # Save a metrics.json placeholder — we don't run tools, so counts are zero.
    metrics = {
        "tool_calls": {},
        "total_tool_calls": 0,
        "total_steps": 1,
        "files_created": ["outputs/output.md"],
        "errors_encountered": 0,
        "output_chars": len(response_text),
        "transcript_chars": len(json.dumps(messages)),
    }
    (outputs_dir / "metrics.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8"
    )

    # Save the full transcript (system + user + assistant) for the viewer.
    transcript = (
        f"# Transcript: {eval_def['name']} / {config_label}\n\n"
        f"## System message\n\n```\n{messages[0]['content'][:8000]}{'...[truncated]' if len(messages[0]['content']) > 8000 else ''}\n```\n\n"
        f"## User message\n\n```\n{messages[1]['content'][:8000]}{'...[truncated]' if len(messages[1]['content']) > 8000 else ''}\n```\n\n"
        f"## Assistant response\n\n{response_text}\n"
    )
    (run_dir / "transcript.md").write_text(transcript, encoding="utf-8")

    # Save full unredacted version separately (gitignored).
    full_transcript = json.dumps(
        {
            "eval_id": eval_def["id"],
            "eval_name": eval_def["name"],
            "configuration": config_label,
            "messages": messages,
            "response": response_text,
            "usage": usage,
        },
        indent=2,
    )
    (run_dir / "transcript-raw.json").write_text(full_transcript, encoding="utf-8")

    # Save timing.json per skill-creator schema.
    timing = {
        "total_tokens": usage.get("total_tokens", 0),
        "duration_ms": int(duration_seconds * 1000),
        "total_duration_seconds": round(duration_seconds, 2),
        "executor_start": started_at,
        "executor_end": ended_at,
        "executor_duration_seconds": round(duration_seconds, 2),
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "cost_usd": usage.get("cost"),
    }
    (run_dir / "timing.json").write_text(
        json.dumps(timing, indent=2), encoding="utf-8"
    )


def run_executor(
    api_key: str,
    eval_def: dict[str, Any],
    *,
    run_dir: Path,
    config_label: str,
    with_skill: bool,
    model: str,
    dry_run: bool,
) -> None:
    messages = build_executor_messages(eval_def, with_skill=with_skill)
    started_at = iso_now()
    t0 = time.time()
    if dry_run:
        response_text = "[DRY RUN — no API call made]"
        usage: dict[str, Any] = {}
    else:
        resp = call_openrouter(api_key, model, messages, max_tokens=8000)
        response_text = extract_text(resp)
        usage = extract_usage(resp)
    duration = time.time() - t0
    ended_at = iso_now()
    write_run_artifacts(
        run_dir,
        eval_def=eval_def,
        config_label=config_label,
        messages=messages,
        response_text=response_text,
        usage=usage,
        started_at=started_at,
        ended_at=ended_at,
        duration_seconds=duration,
    )


def run_grader(
    api_key: str,
    eval_def: dict[str, Any],
    run_dir: Path,
    *,
    model: str,
    dry_run: bool,
) -> dict[str, Any]:
    output_text = (run_dir / "outputs" / "output.md").read_text(encoding="utf-8")
    messages = build_grader_messages(eval_def, output_text)
    grader_started = iso_now()
    t0 = time.time()
    if dry_run:
        # Return synthetic grading for dry-run sanity checks
        grading = {
            "expectations": [
                {"text": e, "passed": False, "evidence": "[DRY RUN]"}
                for e in eval_def["expectations"]
            ],
            "summary": {
                "passed": 0,
                "failed": len(eval_def["expectations"]),
                "total": len(eval_def["expectations"]),
                "pass_rate": 0.0,
            },
            "eval_feedback": {"suggestions": [], "overall": "[DRY RUN]"},
        }
    else:
        resp = call_openrouter(api_key, model, messages, max_tokens=4000)
        grader_text = extract_text(resp).strip()
        # Defensive: strip ``` fences if model added them.
        if grader_text.startswith("```"):
            grader_text = grader_text.split("\n", 1)[1]
            if grader_text.endswith("```"):
                grader_text = grader_text.rsplit("```", 1)[0]
        try:
            grading = json.loads(grader_text)
        except json.JSONDecodeError as e:
            grading = {
                "expectations": [
                    {
                        "text": exp,
                        "passed": False,
                        "evidence": f"[GRADER PARSE ERROR — {e}]",
                    }
                    for exp in eval_def["expectations"]
                ],
                "summary": {
                    "passed": 0,
                    "failed": len(eval_def["expectations"]),
                    "total": len(eval_def["expectations"]),
                    "pass_rate": 0.0,
                },
                "eval_feedback": {
                    "suggestions": [],
                    "overall": f"Grader response was not valid JSON: {grader_text[:500]}",
                },
                "raw_grader_response": grader_text,
            }
    grader_duration = time.time() - t0
    grader_ended = iso_now()

    # Read existing timing.json and add grader fields.
    timing_path = run_dir / "timing.json"
    timing = json.loads(timing_path.read_text(encoding="utf-8"))
    timing["grader_start"] = grader_started
    timing["grader_end"] = grader_ended
    timing["grader_duration_seconds"] = round(grader_duration, 2)
    timing_path.write_text(json.dumps(timing, indent=2), encoding="utf-8")

    # Add execution_metrics + timing to grading.json (skill-creator schema).
    metrics_path = run_dir / "outputs" / "metrics.json"
    grading["execution_metrics"] = json.loads(metrics_path.read_text(encoding="utf-8"))
    grading["timing"] = {
        "executor_duration_seconds": timing.get("executor_duration_seconds"),
        "grader_duration_seconds": timing.get("grader_duration_seconds"),
        "total_duration_seconds": round(
            (timing.get("executor_duration_seconds") or 0)
            + (timing.get("grader_duration_seconds") or 0),
            2,
        ),
    }

    (run_dir / "grading.json").write_text(json.dumps(grading, indent=2), encoding="utf-8")
    return grading


def aggregate_benchmark(
    iteration_dir: Path,
    *,
    skill_name: str,
    executor_model: str,
    runs_per_config: int,
) -> None:
    """Mimic skill-creator's aggregate_benchmark.py without depending on it."""
    runs: list[dict[str, Any]] = []
    eval_dirs = sorted(p for p in iteration_dir.iterdir() if p.is_dir())

    for eval_dir in eval_dirs:
        for config_label in ("with_skill", "without_skill"):
            for n in range(1, runs_per_config + 1):
                run_dir = eval_dir / config_label
                if runs_per_config > 1:
                    run_dir = eval_dir / config_label / f"run-{n}"
                grading_path = run_dir / "grading.json"
                if not grading_path.exists():
                    continue
                grading = json.loads(grading_path.read_text(encoding="utf-8"))
                timing = json.loads((run_dir / "timing.json").read_text(encoding="utf-8"))
                summary = grading.get("summary", {})
                runs.append(
                    {
                        "eval_id": int(eval_dir.name.split("-", 1)[0]) if "-" in eval_dir.name else 0,
                        "eval_name": eval_dir.name,
                        "configuration": config_label,
                        "run_number": n,
                        "result": {
                            "pass_rate": summary.get("pass_rate", 0.0),
                            "passed": summary.get("passed", 0),
                            "failed": summary.get("failed", 0),
                            "total": summary.get("total", 0),
                            "time_seconds": timing.get("executor_duration_seconds", 0.0),
                            "tokens": timing.get("total_tokens", 0),
                            "tool_calls": 0,
                            "errors": 0,
                            "cost_usd": timing.get("cost_usd"),
                        },
                        "expectations": grading.get("expectations", []),
                        "notes": grading.get("eval_feedback", {}).get("overall"),
                    }
                )

    # Run summary aggregates per configuration
    def stats(values: list[float]) -> dict[str, float]:
        if not values:
            return {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0}
        return {
            "mean": round(mean(values), 4),
            "stddev": round(pstdev(values), 4),
            "min": round(min(values), 4),
            "max": round(max(values), 4),
        }

    def runs_for(label: str) -> list[dict[str, Any]]:
        return [r for r in runs if r["configuration"] == label]

    def field_values(label: str, key: str) -> list[float]:
        return [float(r["result"].get(key, 0) or 0) for r in runs_for(label)]

    run_summary: dict[str, Any] = {}
    for label in ("with_skill", "without_skill"):
        run_summary[label] = {
            "pass_rate": stats(field_values(label, "pass_rate")),
            "time_seconds": stats(field_values(label, "time_seconds")),
            "tokens": stats(field_values(label, "tokens")),
        }

    def delta(metric: str) -> str:
        ws = run_summary["with_skill"][metric]["mean"]
        wo = run_summary["without_skill"][metric]["mean"]
        d = ws - wo
        return f"{'+' if d >= 0 else ''}{round(d, 4)}"

    run_summary["delta"] = {
        "pass_rate": delta("pass_rate"),
        "time_seconds": delta("time_seconds"),
        "tokens": delta("tokens"),
    }

    benchmark = {
        "metadata": {
            "skill_name": skill_name,
            "skill_path": str(SKILL_DIR),
            "executor_model": executor_model,
            "analyzer_model": DEFAULT_GRADER_MODEL,
            "timestamp": iso_now(),
            "evals_run": [r["eval_id"] for r in runs if r["configuration"] == "with_skill"],
            "runs_per_configuration": runs_per_config,
        },
        "runs": runs,
        "run_summary": run_summary,
        "notes": [],  # Free-form analyst notes, populated manually after review
    }
    (iteration_dir / "benchmark.json").write_text(
        json.dumps(benchmark, indent=2), encoding="utf-8"
    )

    # Also write a human-readable benchmark.md for quick review.
    md_lines: list[str] = []
    md_lines.append(f"# Benchmark: {skill_name}")
    md_lines.append("")
    md_lines.append(f"- Executor model: `{executor_model}`")
    md_lines.append(f"- Grader model: `{DEFAULT_GRADER_MODEL}`")
    md_lines.append(f"- Timestamp: {benchmark['metadata']['timestamp']}")
    md_lines.append(f"- Runs per configuration: {runs_per_config}")
    md_lines.append("")
    md_lines.append("## Summary")
    md_lines.append("")
    md_lines.append("| Configuration | Pass rate | Time (s) | Tokens |")
    md_lines.append("|---|---|---|---|")
    for label in ("with_skill", "without_skill"):
        s = run_summary[label]
        md_lines.append(
            f"| {label} | {s['pass_rate']['mean']:.2f} ± {s['pass_rate']['stddev']:.2f} | "
            f"{s['time_seconds']['mean']:.1f} ± {s['time_seconds']['stddev']:.1f} | "
            f"{s['tokens']['mean']:.0f} ± {s['tokens']['stddev']:.0f} |"
        )
    md_lines.append(f"| **delta** | {run_summary['delta']['pass_rate']} | "
                    f"{run_summary['delta']['time_seconds']} | "
                    f"{run_summary['delta']['tokens']} |")
    md_lines.append("")
    md_lines.append("## Per-eval results")
    md_lines.append("")
    for eval_dir in eval_dirs:
        md_lines.append(f"### {eval_dir.name}")
        md_lines.append("")
        md_lines.append("| Config | Pass | Fail | Total | Pass rate |")
        md_lines.append("|---|---|---|---|---|")
        for label in ("with_skill", "without_skill"):
            for r in runs:
                if r["eval_name"] == eval_dir.name and r["configuration"] == label:
                    md_lines.append(
                        f"| {label} | {r['result']['passed']} | {r['result']['failed']} | "
                        f"{r['result']['total']} | {r['result']['pass_rate']:.2f} |"
                    )
        md_lines.append("")
    (iteration_dir / "benchmark.md").write_text("\n".join(md_lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iteration", type=int, default=1)
    parser.add_argument("--runs", type=int, default=1, help="Runs per configuration")
    parser.add_argument("--eval-id", type=int, default=None)
    parser.add_argument("--skip-without-skill", action="store_true")
    parser.add_argument("--skip-grader", action="store_true")
    parser.add_argument(
        "--executor-model", default=os.environ.get("CE_EVAL_MODEL", DEFAULT_EXECUTOR_MODEL)
    )
    parser.add_argument(
        "--grader-model", default=os.environ.get("CE_GRADER_MODEL", DEFAULT_GRADER_MODEL)
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not args.dry_run and not api_key:
        print("error: OPENROUTER_API_KEY not set", file=sys.stderr)
        return 2

    evals = json.loads(EVALS_FILE.read_text(encoding="utf-8"))
    skill_name = evals["skill_name"]

    iteration_dir = WORKSPACE_DIR / f"iteration-{args.iteration}"
    iteration_dir.mkdir(parents=True, exist_ok=True)

    selected_evals = (
        [e for e in evals["evals"] if e["id"] == args.eval_id]
        if args.eval_id is not None
        else evals["evals"]
    )

    for eval_def in selected_evals:
        eval_name = f"{eval_def['id']}-{slugify(eval_def['name'])}"
        eval_dir = iteration_dir / eval_name
        eval_dir.mkdir(parents=True, exist_ok=True)

        # Persist eval_metadata.json per skill-creator schema
        (eval_dir / "eval_metadata.json").write_text(
            json.dumps(
                {
                    "eval_id": eval_def["id"],
                    "eval_name": eval_def["name"],
                    "prompt": eval_def["prompt"],
                    "expected_output": eval_def.get("expected_output", ""),
                    "files": eval_def.get("files", []),
                    "expectations": eval_def["expectations"],
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        configs = ["with_skill"]
        if not args.skip_without_skill:
            configs.append("without_skill")

        for config_label in configs:
            for n in range(1, args.runs + 1):
                run_dir = eval_dir / config_label
                if args.runs > 1:
                    run_dir = eval_dir / config_label / f"run-{n}"
                run_dir.mkdir(parents=True, exist_ok=True)

                print(f"  > {eval_name} / {config_label}{f' / run-{n}' if args.runs > 1 else ''} executor...", flush=True)
                run_executor(
                    api_key,
                    eval_def,
                    run_dir=run_dir,
                    config_label=config_label,
                    with_skill=(config_label == "with_skill"),
                    model=args.executor_model,
                    dry_run=args.dry_run,
                )

                if not args.skip_grader:
                    print(f"  > {eval_name} / {config_label}{f' / run-{n}' if args.runs > 1 else ''} grader...", flush=True)
                    grading = run_grader(
                        api_key,
                        eval_def,
                        run_dir,
                        model=args.grader_model,
                        dry_run=args.dry_run,
                    )
                    s = grading["summary"]
                    print(
                        f"    pass {s['passed']}/{s['total']} ({s['pass_rate']:.0%})",
                        flush=True,
                    )

    if not args.skip_grader:
        aggregate_benchmark(
            iteration_dir,
            skill_name=skill_name,
            executor_model=args.executor_model,
            runs_per_config=args.runs,
        )
        print(f"\nbenchmark: {iteration_dir / 'benchmark.md'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
