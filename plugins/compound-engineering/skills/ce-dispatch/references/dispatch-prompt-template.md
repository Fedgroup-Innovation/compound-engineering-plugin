# Dispatch Prompt Template

Build the dispatch prompt for a single implementation unit using the XML-tagged sections below. The full rendered prompt becomes the **GitHub issue body** so the in-workspace agent (e.g., a Conductor workspace opened in the user-supplied worktree) sees the entire instruction set as its starting context.

The prompt is intentionally self-contained: do not assume the in-workspace agent has access to scratch directories, side-channel files, or shared state with the dispatching orchestrator. The plan file and orientation files are referenced by repo-relative path so the agent can `Read` them for additional context (progressive context exposure -- list paths, do not inline content).

This template is for **single-unit sync MVP dispatch**. Multi-unit fan-out, dependency-graph metadata, and parallel coordination hints are intentionally not part of this template.

## Required structure

Render exactly these sections, in this order. Keep the XML tags so downstream tooling (and the contract test) can validate structure.

```xml
<orientation>
[A checklist of repo-relative paths the agent should `Read` first, before doing
any work. Include only paths that exist in the target repo. Recommended set:
- The plan file (this unit was extracted from it)
- README.md
- AGENTS.md (and CLAUDE.md if it diverges from AGENTS.md; root-level and any
  plugin-scoped equivalents the unit touches)
- docs/architecture.md, docs/architecture/, or any top-level architecture doc
- The unit's `Patterns to follow` files (verbatim from the unit)
- The unit's `Files:` paths so the agent reads existing code before editing

Render as a Markdown bullet list with each path inline-quoted in backticks.
The agent reads these to come in green and build context, rather than the
orchestrator wasting prompt tokens inlining the content here.]
</orientation>

<agent-identity>
[The agent's name and worktree absolute path, supplied by the user when
ce-dispatch was invoked.

Render as:
- agent-name: `<worktree dirname, e.g. jackson>`
- worktree-path: `<absolute path, e.g. /Users/you/conductor/workspaces/repo/jackson>`

The agent uses `agent-name` to sign comments on this issue
(`[<agent-name> -> orchestrator]`). The orchestrator addresses the agent the
same way (`[orchestrator -> <agent-name>]`). It is purely a label -- no
infrastructure depends on it.]
</agent-identity>

<context>
[One paragraph orienting the in-workspace agent:
- Plan file path (repo-relative) the unit was extracted from
- One-sentence project context (read from plan frontmatter / repo README if available)
- Note that this issue was created by ce-dispatch and corresponds to a single
  implementation unit from the plan.
The agent should `Read` the plan file (and the orientation files above) for
the full picture before starting.]
</context>

<task>
[The Goal from the implementation unit, verbatim. Single-unit dispatch only --
no multi-unit coalescing in this template.]
</task>

<files>
[The unit's combined file list -- files to create, modify, or read.
Use the plan's `Files:` section as the source of truth. Repo-relative paths only.]
</files>

<patterns>
[File paths and conventions from the unit's "Patterns to follow" field. If no
patterns are specified: "No explicit patterns referenced -- follow existing
conventions in the modified files."]
</patterns>

<approach>
[The Approach from the unit, verbatim.]
</approach>

<constraints>
- Commit changes with conventional commit messages (e.g., `feat(scope): ...`,
  `fix(scope): ...`, `docs(scope): ...`). One logical change per commit; squash
  noise locally before pushing.
- Push to a dedicated branch. The orchestrator suggests `<expected-branch>` in
  the metadata footer below -- prefer that name so the orchestrator can
  correlate the PR back to the unit's U-ID. If the harness or workspace tool
  has already named the branch differently, that is fine -- the U-ID in the PR
  body keeps correlation working.
- Open a pull request against `<base-branch>` when the unit is complete. Use
  the in-harness PR creation flow if one is available (Conductor's `Create PR`
  action, the `ce-commit-push-pr` skill, etc.); otherwise `gh pr create`.
- Keep changes tightly scoped to the stated task. Do not pull adjacent
  refactors, renames, or cleanup into this unit -- those belong in a separate
  unit or a follow-up issue.
- Restrict modifications to files within the repository root.
- Resolve the task fully before opening the PR. Do not stop at the first
  plausible implementation if verification has not passed.
- If you discover mid-execution that the unit's scope is wrong, the plan is
  inconsistent, or required context is missing, surface that in a new comment
  on this issue using the `<comment-protocol>` below -- do not silently
  expand scope.
</constraints>

<testing>
Before writing tests, check whether the plan's test scenarios cover all
categories that apply to this unit. Supplement gaps before writing tests:
- Happy path: core input/output pairs from the unit's goal
- Edge cases: boundary values, empty/nil inputs, type mismatches
- Error/failure paths: invalid inputs, permission denials, downstream failures
- Integration: cross-layer scenarios that mocks alone won't prove

Write tests that name specific inputs and expected outcomes. If your changes
touch code with callbacks, middleware, or event handlers, verify the
interaction chain works end-to-end.
</testing>

<verify>
After implementing, run ALL test files together in a single command (not
per-file). Cross-file contamination (e.g., mocked globals leaking between
test files) only surfaces when tests run in the same process. If tests fail,
fix the issues and re-run until they pass. Do not open the PR until
verification passes -- the orchestrator will not re-run verification before
merging.

[Test and lint commands from the project. Use the unit's verification
commands as a single combined invocation.]
</verify>

<ce-plugin>
The Compound Engineering (CE) plugin is the recommended path for this
dispatch. Follow the **nine-step sequence** below. Each step is explicit so
the agent runs the full compound-engineering loop end-to-end (work -> code
review -> compound -> PR -> standby for feedback).

1. **Read the orientation files** in `<orientation>` above. Build context
   before doing any work. Do not skip this -- the orchestrator selected
   these files specifically.
2. **Run `/ce-work`** with the plan path passed as the argument (use the
   platform's skill-invocation primitive: `Skill` in Claude Code, `Skill`
   in Codex, the equivalent on Gemini/Pi). `ce-work` reads the plan, builds
   a task list scoped to this unit's U-ID, and walks the implementation.
   If `ce-work` produces a task list that needs the orchestrator's input
   (ambiguity, missing context, scope question), STOP and use the
   `<comment-protocol>` to ask -- do not proceed past the question.
3. **Implement and verify** per `<task>`, `<files>`, `<patterns>`,
   `<approach>`, `<constraints>`, `<testing>`, and `<verify>` above.
4. **Run `/ce-code-review`** against your branch before opening the PR.
   Use the platform's skill-invocation primitive. Address findings inline
   if straightforward; defer to the orchestrator via the comment protocol
   if the finding implies architectural change.
5. **Run `/ce-compound`** if the unit produced learnings worth capturing
   (a non-obvious bug fix, a pattern that should be documented, a
   reproducible failure mode). Skip when there are no learnings.
6. **Run `/ce-commit-push-pr`** to commit the work, push the branch, and
   open the PR with an adaptive description. If `ce-commit-push-pr` is not
   available in this workspace, fall back to `git commit && git push &&
   gh pr create` and write the `## Dispatch Result` section by hand per
   `<output-contract>`.
7. **Append a comment** to this issue with the PR URL. Format:
   `**[<agent-name> -> orchestrator] <ISO 8601 UTC>**\n\nPR opened: <pr-url>. Standing by for review.`
8. **Stop. Wait for orchestrator ping.** Do not poll. Do not start the
   next unit. Conductor (or the user) will surface the new orchestrator
   comment to you when the orchestrator replies.
9. **On orchestrator ping** with PR feedback: run `/ce-resolve-pr-feedback`
   on the PR (use the platform's skill-invocation primitive). On
   orchestrator ping with an issue-comment clarification: re-read the
   issue thread, then continue the work. Loop until the orchestrator
   approves the PR.

If the CE plugin is **not** installed in this workspace, fall back to
following `<task>`, `<files>`, `<patterns>`, `<approach>`, `<constraints>`,
`<testing>`, and `<verify>` directly, and use `git` + `gh` for the
commit/push/PR steps. The compound-engineering sequence still applies; only
the skill invocations are replaced with manual equivalents.
</ce-plugin>

<comment-protocol>
Use issue comments **only for clarifications** you cannot resolve from this
issue body and the orientation files. Routine progress updates do not
belong in comments -- the PR description is the durable progress surface.

**When to comment:**
- A decision you cannot make from this issue body alone changes a public
  interface.
- A decision introduces a new dependency or pattern not already in
  `<patterns>` or the orientation files.
- The unit's stated approach turns out to be wrong, inconsistent with the
  plan, or missing required context.
- Verification reveals the plan itself is wrong (e.g., the test scenarios
  contradict the goal).

**Format:**
- Open a new comment on this issue.
- First line: `**[<agent-name> -> orchestrator] <ISO 8601 UTC timestamp>**`
- Then a blank line, then the body. The body must include:
  1. **Question** -- one or two sentences naming the decision.
  2. **What you considered** -- options you evaluated and why none was
     obvious.
  3. **What you need from the orchestrator** -- the specific input that
     unblocks you.

**After commenting:**
- STOP. Do not proceed past the open question. Do not start the next
  related task. Wait for an `**[orchestrator -> <agent-name>] <timestamp>**`
  reply.
- On reply, re-read the full comment thread before continuing.
- If the reply does not fully unblock, ask a follow-up using the same
  format and stop again.

The orchestrator addresses you in the same shape:
`**[orchestrator -> <agent-name>] <ISO 8601 UTC>**` followed by the reply
body. You should be able to identify orchestrator replies unambiguously
from the prefix.
</comment-protocol>

<output-contract>
Report the result via the **PR description**, not via a JSON file or scratch
artifact -- ce-dispatch reads the PR body in the Phase 4 respond loop to
drive review and merge gating.

Render this section verbatim under a top-level `## Dispatch Result` heading
in the PR description (Markdown, not XML in the rendered PR):

## Dispatch Result

**Status:** `completed` | `partial` | `failed`
- `completed` -- all changes were made AND verification passes
- `partial` -- some changes made; specifics in `Issues`
- `failed` -- no meaningful progress

**Files modified:**
- list of repo-relative file paths actually changed in this PR

**Issues:**
- bullets describing any problems, gaps, scope creep avoided, or out-of-scope
  work the orchestrator should know about. Use `None` if there are none.

**Summary:** one short paragraph describing what was done.

**Verification:** the command(s) you ran and their outcome
(e.g., `bun test -- 14 passed, 0 failed` or `pytest -- exit code 0`).
If verification was not possible, say why.

**Unit ID:** the U-ID this PR satisfies (e.g., `U3`).
**Plan path:** the repo-relative plan file path.
</output-contract>
```

## Metadata footer

Append the following HTML comment **outside** the `<output-contract>` block, at the very end of the rendered issue body. The comment is invisible in the GitHub UI but parseable by `ce-dispatch` on subsequent runs (and other tooling that wants to round-trip dispatch state).

```html
<!-- ce-dispatch-metadata
plan: <repo-relative plan path>
unit_id: <single U-ID for this dispatch, e.g. U3>
agent_name: <worktree dirname, e.g. jackson>
worktree_path: <absolute path the user supplied>
expected_branch: <suggested branch name, e.g. dispatch/U3-add-rate-limiter>
base_branch: <base branch the eventual PR targets, e.g. main>
labels: <comma-separated labels applied to the issue>
dispatched_at: <ISO 8601 UTC timestamp>
-->
```

Note: `dependencies:` is intentionally absent from the metadata in this single-unit MVP. Dependency-graph orchestration is out of scope for the MVP; the orchestrator does not gate merges on dependency state. A future iteration can re-introduce the field when multi-unit dispatch returns.

## What the orchestrator does NOT include in the prompt

- **Scratch directory paths**: the in-workspace agent has its own filesystem; do not reference paths from the orchestrator's machine.
- **Codex CLI invocation flags or `--output-schema` artifacts**: `ce-dispatch` does not delegate to `codex exec` directly; the in-workspace agent runs whatever harness Conductor (or another platform) provides.
- **Orchestrator-private state**: dependency graphs, parallel-safety analysis, dispatch order. The single-unit MVP does not produce any of those.

## Token budget guidance

Keep the rendered prompt under ~8k tokens when possible. The `<orientation>` block is the main lever: list paths, do not inline content. If a unit's plan section is large, link to the plan via repo-relative path inside `<context>` rather than inlining the full text -- the agent can `Read` it.
