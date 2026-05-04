import { readFileSync } from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { load as parseYaml } from "js-yaml"

const SKILL_PATH = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-dispatch/SKILL.md",
)
const TEMPLATE_PATH = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-dispatch/references/dispatch-prompt-template.md",
)
const CONDUCTOR_NOTES_PATH = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-dispatch/references/conductor-notes.md",
)
const SETUP_CONFIG_PATH = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-setup/references/config-template.yaml",
)
const ROOT_CONFIG_PATH = path.join(
  process.cwd(),
  ".compound-engineering/config.local.example.yaml",
)
const PLAN_HANDOFF_PATH = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-plan/references/plan-handoff.md",
)
const PLAN_SKILL_PATH = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-plan/SKILL.md",
)

const SKILL_BODY = readFileSync(SKILL_PATH, "utf8")
const TEMPLATE_BODY = readFileSync(TEMPLATE_PATH, "utf8")
const CONDUCTOR_NOTES_BODY = readFileSync(CONDUCTOR_NOTES_PATH, "utf8")
const SETUP_CONFIG_BODY = readFileSync(SETUP_CONFIG_PATH, "utf8")
const ROOT_CONFIG_BODY = readFileSync(ROOT_CONFIG_PATH, "utf8")
const PLAN_HANDOFF_BODY = readFileSync(PLAN_HANDOFF_PATH, "utf8")
const PLAN_SKILL_BODY = readFileSync(PLAN_SKILL_PATH, "utf8")

function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) {
    throw new Error("No frontmatter block found")
  }
  return parseYaml(match[1]) as Record<string, unknown>
}

describe("ce-dispatch SKILL.md frontmatter", () => {
  const fm = parseFrontmatter(SKILL_BODY)

  test("name is ce-dispatch", () => {
    expect(fm.name).toBe("ce-dispatch")
  })

  test("description carries [BETA] prefix per the beta-skills framework", () => {
    const description = fm.description
    expect(typeof description).toBe("string")
    const desc = description as string
    expect(desc.length).toBeGreaterThan(40)
    expect(desc.length).toBeLessThanOrEqual(1024)
    // BETA marker (paired with disable-model-invocation: true)
    expect(desc.startsWith("[BETA]")).toBe(true)
  })

  test("description names dispatch + single implementation unit (single-unit MVP shape)", () => {
    const desc = (parseFrontmatter(SKILL_BODY).description as string).toLowerCase()
    expect(desc).toContain("dispatch")
    expect(desc).toContain("implementation unit")
    // The MVP is single-unit; the description should reflect that so users
    // who skim it (or AskUserQuestion summaries) don't expect fan-out.
    expect(desc).toContain("single")
  })

  test("disable-model-invocation is true (beta skill triplet)", () => {
    expect(fm["disable-model-invocation"]).toBe(true)
  })

  test("argument-hint references plan path with auto-detect fallback", () => {
    const hint = fm["argument-hint"]
    expect(typeof hint).toBe("string")
    expect((hint as string).toLowerCase()).toContain("plan")
  })
})

describe("ce-dispatch SKILL.md phases", () => {
  // Anchor on the `### Phase N:` heading marker so a stray prose mention of
  // "Phase 1" earlier in the file doesn't shift the region boundaries.
  function phaseHeadingIndex(n: number): number {
    return SKILL_BODY.indexOf(`### Phase ${n}:`)
  }

  test("contains all required phase headings (0-4)", () => {
    for (const n of [0, 1, 2, 3, 4]) {
      expect(phaseHeadingIndex(n)).toBeGreaterThan(-1)
    }
  })

  test("Phase 0 covers input + config resolution + worktree confirmation", () => {
    const phase0Start = phaseHeadingIndex(0)
    const phase1Start = phaseHeadingIndex(1)
    expect(phase0Start).toBeGreaterThan(-1)
    expect(phase1Start).toBeGreaterThan(phase0Start)
    const phase0Region = SKILL_BODY.slice(phase0Start, phase1Start)
    // Mentions reading dispatch_* config from .compound-engineering/config.local.yaml
    expect(phase0Region).toContain("dispatch_")
    expect(phase0Region).toContain("config.local.yaml")
    // Auto-detects latest plan when input is blank
    expect(phase0Region.toLowerCase()).toContain("latest")
    expect(phase0Region).toContain("docs/plans")
    // Single-unit MVP-specific: Phase 0 confirms a worktree path (the chicken-
    // and-egg fix -- user creates the workspace before the skill creates the
    // issue) and uses the worktree dirname as the agent name.
    expect(phase0Region.toLowerCase()).toContain("worktree")
    expect(phase0Region.toLowerCase()).toContain("agent name")
  })

  test("Phase 0 documents only the three retained dispatch_* keys (single-unit MVP)", () => {
    const phase0Start = phaseHeadingIndex(0)
    const phase1Start = phaseHeadingIndex(1)
    const phase0Region = SKILL_BODY.slice(phase0Start, phase1Start)
    // Retained keys
    expect(phase0Region).toContain("dispatch_branch_prefix")
    expect(phase0Region).toContain("dispatch_base_branch")
    expect(phase0Region).toContain("dispatch_labels")
    // Removed keys must NOT be documented as live config (the SKILL.md may
    // mention them by name in the "Removed in this MVP" callout, but they
    // must not appear in the live config table). Anchor on the table row
    // shape `| <key>` so a callout that references the removed name in
    // prose doesn't satisfy the assertion.
    expect(phase0Region).not.toMatch(/^\|\s*`?dispatch_mode`?\s*\|/m)
    expect(phase0Region).not.toMatch(/^\|\s*`?dispatch_auto_review`?\s*\|/m)
  })

  test("Phase 1 picks ONE implementation unit (no dependency graph in MVP)", () => {
    const phase1Start = phaseHeadingIndex(1)
    const phase2Start = phaseHeadingIndex(2)
    expect(phase2Start).toBeGreaterThan(phase1Start)
    const phase1Region = SKILL_BODY.slice(phase1Start, phase2Start)
    // Reads the plan and parses implementation units
    expect(phase1Region.toLowerCase()).toContain("implementation unit")
    // Single-unit MVP: explicitly picks one
    expect(phase1Region.toLowerCase()).toMatch(/(pick|select)[^.]*one/)
    // The MVP intentionally drops parallel-safety / dependency-graph behavior
    // -- those will return when multi-unit dispatch returns. Guard against
    // accidental re-introduction in the wrong phase.
    expect(phase1Region).not.toContain("Parallel Safety Check")
  })

  test("Phase 2 generates the dispatch prompt using the template", () => {
    const phase2Start = phaseHeadingIndex(2)
    const phase3Start = phaseHeadingIndex(3)
    const phase2Region = SKILL_BODY.slice(phase2Start, phase3Start)
    expect(phase2Region).toContain("references/dispatch-prompt-template.md")
    // The single-unit MVP requires the new <orientation>, <agent-identity>,
    // and <comment-protocol> sections to be populated alongside the legacy
    // sections. Phase 2 is where they get filled in.
    expect(phase2Region).toContain("<orientation>")
    expect(phase2Region).toContain("<agent-identity>")
    expect(phase2Region).toContain("<comment-protocol>")
  })

  test("Phase 3 creates exactly one issue via gh", () => {
    const phase3Start = phaseHeadingIndex(3)
    const phase4Start = phaseHeadingIndex(4)
    const phase3Region = SKILL_BODY.slice(phase3Start, phase4Start)
    expect(phase3Region).toContain("gh issue create")
    expect(phase3Region).toContain("[CE-Dispatch]")
    expect(phase3Region.toLowerCase()).toContain("label")
    // Single-unit MVP: tells the user to open the Conductor workspace and
    // point the agent at the new issue. The handoff instruction is what
    // closes the chicken-and-egg loop.
    expect(phase3Region.toLowerCase()).toContain("conductor")
  })

  test("Phase 4 respond loop has exactly four options (single-unit MVP)", () => {
    const phase4Start = phaseHeadingIndex(4)
    const phase4Region = SKILL_BODY.slice(phase4Start)
    // The four MVP menu options
    expect(phase4Region).toContain("Reply to agent comment")
    expect(phase4Region).toContain("Review the PR")
    expect(phase4Region).toContain("Mark unit complete")
    expect(phase4Region).toContain("Done for now")
    // Four options fits the 4-option blocking-tool cap, so the SKILL.md
    // should explicitly say to use the blocking question tool (not a
    // numbered list in chat).
    expect(phase4Region.toLowerCase()).toContain("blocking question tool")
    // The MVP intentionally drops the dependency-aware merge gate, the
    // dependency-graph rendering, and the auto-review path. Guard against
    // accidental re-introduction.
    expect(phase4Region).not.toContain("Show dependency graph")
    expect(phase4Region).not.toContain("Dispatch newly unblocked units")
  })

  test("Phase 4 routing references ce-resolve-pr-feedback for PR feedback round-trip", () => {
    const phase4Start = phaseHeadingIndex(4)
    const phase4Region = SKILL_BODY.slice(phase4Start)
    // The dispatch-side respond loop hands PR-review feedback back to the
    // in-workspace agent via ce-resolve-pr-feedback. Without this routing
    // the user has to remember the chain manually -- defeats the point of
    // composing existing CE skills.
    expect(phase4Region).toContain("ce-resolve-pr-feedback")
    expect(phase4Region).toContain("ce-code-review")
  })
})

describe("dispatch-prompt-template required XML sections", () => {
  // The single-unit MVP expands the section list with three new ones
  // (<orientation>, <agent-identity>, <comment-protocol>) that capture the
  // sync-comms protocol. Existing sections stay so the dispatched agent's
  // mental model of the prompt shape is unchanged.
  const requiredSections = [
    "<orientation>",
    "<agent-identity>",
    "<context>",
    "<task>",
    "<files>",
    "<patterns>",
    "<approach>",
    "<constraints>",
    "<testing>",
    "<verify>",
    "<ce-plugin>",
    "<comment-protocol>",
    "<output-contract>",
  ]

  for (const section of requiredSections) {
    test(`template contains ${section} section`, () => {
      expect(TEMPLATE_BODY).toContain(section)
    })
  }

  test("template metadata footer is an HTML comment with single-unit keys", () => {
    expect(TEMPLATE_BODY).toContain("ce-dispatch-metadata")
    expect(TEMPLATE_BODY).toContain("plan:")
    // Single-unit MVP: unit_id (singular), not unit_ids (multi).
    expect(TEMPLATE_BODY).toContain("unit_id:")
    expect(TEMPLATE_BODY).not.toMatch(/^unit_ids:/m)
    // New single-unit-specific metadata: agent_name + worktree_path
    expect(TEMPLATE_BODY).toContain("agent_name:")
    expect(TEMPLATE_BODY).toContain("worktree_path:")
    // Existing keys
    expect(TEMPLATE_BODY).toContain("expected_branch:")
    expect(TEMPLATE_BODY).toContain("base_branch:")
    expect(TEMPLATE_BODY).toContain("labels:")
    expect(TEMPLATE_BODY).toContain("dispatched_at:")
  })

  test("template metadata footer drops dependencies (single-unit MVP)", () => {
    // The MVP does not gate on a dependency graph; carrying `dependencies:`
    // in the metadata implies behavior the skill no longer enforces. Guard
    // against accidental re-introduction.
    // Anchor on `<key>:` shape so a prose mention of the word "dependencies"
    // doesn't satisfy the assertion. The metadata footer has the key on its
    // own line.
    expect(TEMPLATE_BODY).not.toMatch(/^dependencies:/m)
  })
})

describe("dispatch-prompt-template <ce-plugin> nine-step compound-engineering loop", () => {
  function extractSection(body: string, tag: string): string {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = body.indexOf(open)
    const end = body.indexOf(close, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return body.slice(start + open.length, end)
  }

  test("ce-plugin block invokes the four CE skills the agent runs end-to-end", () => {
    const cePluginSection = extractSection(TEMPLATE_BODY, "ce-plugin")
    // The four CE skills the dispatched agent invokes during its loop.
    // Without these explicit references the agent might paraphrase the steps
    // and drift from the compound-engineering sequence.
    expect(cePluginSection).toContain("/ce-work")
    expect(cePluginSection).toContain("/ce-code-review")
    expect(cePluginSection).toContain("/ce-compound")
    expect(cePluginSection).toContain("/ce-commit-push-pr")
    // PR-feedback round-trip is via ce-resolve-pr-feedback after the
    // orchestrator pings.
    expect(cePluginSection).toContain("/ce-resolve-pr-feedback")
  })

  test("ce-plugin block is a numbered nine-step sequence", () => {
    const cePluginSection = extractSection(TEMPLATE_BODY, "ce-plugin")
    // Steps 1-9 must each appear as `N.` at the start of a line. This is
    // the prescriptive form -- an unnumbered list of suggestions is what
    // we used to have, and it caused dispatched agents to skip steps.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const stepPattern = new RegExp(`^${n}\\.\\s+\\*\\*`, "m")
      expect(stepPattern.test(cePluginSection)).toBe(true)
    }
  })

  test("ce-plugin block tells the agent to STOP and wait for orchestrator ping", () => {
    const cePluginSection = extractSection(TEMPLATE_BODY, "ce-plugin")
    // After PR open, the agent must STOP. Without this directive the agent
    // tends to start the next plausible task; the sync MVP requires it to
    // wait for the orchestrator's review.
    expect(cePluginSection.toLowerCase()).toContain("stop")
    expect(cePluginSection.toLowerCase()).toContain("wait for orchestrator")
    expect(cePluginSection.toLowerCase()).toContain("do not poll")
  })
})

describe("dispatch-prompt-template <orientation> + <agent-identity>", () => {
  function extractSection(body: string, tag: string): string {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = body.indexOf(open)
    const end = body.indexOf(close, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return body.slice(start + open.length, end)
  }

  test("<orientation> lists paths (progressive context exposure), does not inline content", () => {
    const orientation = extractSection(TEMPLATE_BODY, "orientation")
    // The block must direct the agent to `Read` paths -- not embed them.
    // This is the progressive-context-exposure principle: list paths, let
    // the agent read what it needs.
    expect(orientation.toLowerCase()).toContain("read")
    expect(orientation.toLowerCase()).toContain("repo-relative")
    // Recommended set must mention the canonical orientation files so a
    // sloppy renderer can't ship an empty orientation block.
    expect(orientation).toContain("README")
    expect(orientation).toContain("AGENTS.md")
    expect(orientation.toLowerCase()).toContain("plan")
  })

  test("<agent-identity> carries agent-name and worktree-path", () => {
    const identity = extractSection(TEMPLATE_BODY, "agent-identity")
    // Both pieces ride here so the comment-protocol prefix
    // ([<agent-name> -> orchestrator]) and the orchestrator's "open the
    // worktree at <path>" hint both have a single source of truth.
    expect(identity).toContain("agent-name")
    expect(identity).toContain("worktree-path")
  })
})

describe("dispatch-prompt-template <comment-protocol>", () => {
  function extractSection(body: string, tag: string): string {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = body.indexOf(open)
    const end = body.indexOf(close, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return body.slice(start + open.length, end)
  }

  test("comment-protocol restricts comments to clarifications", () => {
    const protocol = extractSection(TEMPLATE_BODY, "comment-protocol")
    // The MVP separates two surfaces: comments are for blocking
    // clarifications; the PR description is for routine progress. Without
    // this guardrail agents tend to chat-log progress on the issue, which
    // floods the orchestrator's review surface.
    expect(protocol.toLowerCase()).toContain("clarification")
  })

  test("comment-protocol prescribes the timestamped <agent-name> -> orchestrator format", () => {
    const protocol = extractSection(TEMPLATE_BODY, "comment-protocol")
    // The prefix shape is what the SKILL.md Phase 4 routing parses to find
    // the latest agent comment. Drift in the prefix shape breaks the
    // round-trip silently.
    expect(protocol).toContain("[<agent-name> -> orchestrator]")
    expect(protocol).toContain("[orchestrator -> <agent-name>]")
    expect(protocol.toLowerCase()).toContain("iso 8601")
  })

  test("comment-protocol tells agent to STOP after asking, not proceed", () => {
    const protocol = extractSection(TEMPLATE_BODY, "comment-protocol")
    // The whole point of the comment protocol is: ask, then stop. If the
    // agent proceeds anyway it will make architectural decisions without
    // the orchestrator's full context (the airgap concern). Guard the
    // STOP-after-ask directive.
    expect(protocol.toLowerCase()).toContain("stop")
    expect(protocol.toLowerCase()).toContain("wait for")
    expect(protocol.toLowerCase()).toContain("do not proceed")
  })
})

describe("dispatch-prompt-template constraints (PR-based, not no-git)", () => {
  function extractSection(body: string, tag: string): string {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = body.indexOf(open)
    const end = body.indexOf(close, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return body.slice(start + open.length, end)
  }

  test("constraints does NOT forbid git commit/push/PR creation (the Codex constraint set)", () => {
    const constraints = extractSection(TEMPLATE_BODY, "constraints")
    // The Codex template said "Do NOT run git commit, git push, or create PRs"
    // ce-dispatch flips that — dispatched agents own the full git lifecycle.
    expect(constraints).not.toMatch(/Do NOT run git commit/i)
    expect(constraints).not.toMatch(/Do NOT run git push/i)
    expect(constraints).not.toMatch(/Do not run git commit/i)
  })

  test("constraints DOES instruct the agent to commit, push, and open a PR", () => {
    const constraints = extractSection(TEMPLATE_BODY, "constraints")
    expect(constraints.toLowerCase()).toContain("commit")
    expect(constraints.toLowerCase()).toContain("push")
    // Must explicitly say "Open a PR" / "open a pull request"
    expect(constraints).toMatch(/[Oo]pen a (?:PR|pull request)/)
    // Conventional commit messages
    expect(constraints.toLowerCase()).toContain("conventional commit")
  })
})

describe("dispatch-prompt-template output contract (PR description, not JSON file)", () => {
  function extractSection(body: string, tag: string): string {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = body.indexOf(open)
    const end = body.indexOf(close, start)
    return body.slice(start + open.length, end)
  }

  test("output-contract does NOT reference --output-schema (Codex-specific JSON contract)", () => {
    const contract = extractSection(TEMPLATE_BODY, "output-contract")
    expect(contract).not.toContain("--output-schema")
    expect(contract).not.toContain("output-schema")
    expect(contract).not.toContain("result-schema.json")
  })

  test("output-contract reports via PR description under '## Dispatch Result'", () => {
    const contract = extractSection(TEMPLATE_BODY, "output-contract")
    expect(contract.toLowerCase()).toContain("pr description")
    expect(contract).toContain("## Dispatch Result")
  })

  test("output-contract requires the documented fields", () => {
    const contract = extractSection(TEMPLATE_BODY, "output-contract")
    // Required fields per the SKILL.md / template spec
    expect(contract.toLowerCase()).toContain("status")
    expect(contract.toLowerCase()).toContain("files modified")
    expect(contract.toLowerCase()).toContain("issues")
    expect(contract.toLowerCase()).toContain("summary")
    expect(contract.toLowerCase()).toContain("verification")
    expect(contract).toContain("Unit ID")
    expect(contract.toLowerCase()).toContain("plan path")
  })
})

describe("config templates carry the retained dispatch_* keys (single-unit MVP)", () => {
  // The MVP keeps three keys and drops two. Both config files MUST mirror
  // each other -- the contract test below checks both surfaces explicitly
  // because past drift between them caused silent default mismatches.
  const retainedKeys = [
    "dispatch_branch_prefix",
    "dispatch_base_branch",
    "dispatch_labels",
  ]
  const droppedKeys = ["dispatch_mode", "dispatch_auto_review"]

  for (const key of retainedKeys) {
    test(`ce-setup config-template.yaml documents retained key ${key}`, () => {
      expect(SETUP_CONFIG_BODY).toContain(key)
    })

    test(`root config.local.example.yaml documents retained key ${key}`, () => {
      expect(ROOT_CONFIG_BODY).toContain(key)
    })
  }

  for (const key of droppedKeys) {
    test(`ce-setup config-template.yaml drops removed key ${key}`, () => {
      expect(SETUP_CONFIG_BODY).not.toContain(key)
    })

    test(`root config.local.example.yaml drops removed key ${key}`, () => {
      expect(ROOT_CONFIG_BODY).not.toContain(key)
    })
  }
})

describe("ce-plan post-generation menu surfaces dispatch as a fifth option", () => {
  test("plan-handoff.md lists 'Dispatch to external agents' as option 4 in the menu", () => {
    // The numbered menu still has 5 options; "Dispatch" still sits at
    // position 4 (between Proof and Done for now). Single-unit MVP changes
    // the action description in the routing line, not the menu label.
    expect(PLAN_HANDOFF_BODY).toMatch(
      /4\.\s+\*\*Dispatch to external agents\*\*/,
    )
    expect(PLAN_HANDOFF_BODY).toMatch(/5\.\s+\*\*Done for now\*\*/)
  })

  test("plan-handoff.md routes the dispatch option to the ce-dispatch skill", () => {
    // Routing bullet (not the menu list) names ce-dispatch and the plan path
    expect(PLAN_HANDOFF_BODY).toContain(
      "- **Dispatch to external agents** ->",
    )
    expect(PLAN_HANDOFF_BODY.toLowerCase()).toContain("ce-dispatch")
    // Inline routing must name the platform's skill-invocation primitive
    // (per docs/solutions/skill-design/post-menu-routing-belongs-inline-2026-04-28.md)
    expect(PLAN_HANDOFF_BODY).toContain("skill-invocation primitive")
  })

  test("ce-plan SKILL.md inline routing fires ce-dispatch (not just text)", () => {
    // The inline routing in SKILL.md must also name the skill-invocation
    // primitive so an agent that hasn't loaded plan-handoff.md still routes
    // correctly. Mirrors the regression guard from
    // tests/skills/ce-plan-handoff-routing.test.ts.
    const phaseStart = PLAN_SKILL_BODY.indexOf("##### 5.3.8")
    expect(phaseStart).toBeGreaterThan(-1)
    const phaseRegion = PLAN_SKILL_BODY.slice(phaseStart)
    expect(phaseRegion).toMatch(
      /-\s+\*\*Dispatch to external agents\*\*\s*[—\-]+>?\s*[^\n]+/,
    )
    // Names the primitive and references the plan path
    const dispatchBullet = phaseRegion.match(
      /-\s+\*\*Dispatch to external agents\*\*[^\n]+/,
    )
    expect(dispatchBullet).not.toBeNull()
    const bulletText = dispatchBullet![0]
    expect(bulletText.toLowerCase()).toContain("skill-invocation primitive")
    expect(bulletText.toLowerCase()).toContain("plan path")
  })

  test("ce-plan routing wording reflects single-unit MVP shape (no fan-out language)", () => {
    // The MVP dispatches one unit per invocation. Routing copy that talks
    // about "fanning out" or "parallel execution" misleads users who skim
    // the routing line and expect multi-issue creation. Both surfaces
    // (SKILL.md and plan-handoff.md) must converge.
    const phaseStart = PLAN_SKILL_BODY.indexOf("##### 5.3.8")
    const phaseRegion = PLAN_SKILL_BODY.slice(phaseStart)
    const dispatchBullet = phaseRegion.match(
      /-\s+\*\*Dispatch to external agents\*\*[^\n]+/,
    )
    expect(dispatchBullet).not.toBeNull()
    expect(dispatchBullet![0].toLowerCase()).not.toMatch(/fan out|fan-out|parallel execution/)

    const handoffLine = PLAN_HANDOFF_BODY.match(
      /\*\*Dispatch to external agents\*\* ->[^\n]+/,
    )
    expect(handoffLine).not.toBeNull()
    expect(handoffLine![0].toLowerCase()).not.toMatch(/fan out|fan-out|parallel execution/)
  })
})

describe("ce-dispatch SKILL.md regression guards (Codex-flagged bugs)", () => {
  // Both guards target real bugs flagged by the upstream's chatgpt-codex-connector
  // bot on EveryInc#762. Without these, the original `gh pr list` and
  // `git symbolic-ref` invocations silently return the wrong data.

  test("Phase 4 PR-discovery query uses --state all so merged PRs are visible", () => {
    // `gh pr list` defaults to open PRs only (CLI manual: "only lists open PRs"
    // by default). A PR merged outside this orchestrator (GitHub UI,
    // Conductor, another shell) must still be discoverable when the user
    // re-enters the loop later, otherwise `Mark unit complete` can't find
    // the merged PR. Required: --state all (or --state merged on a separate
    // pass).
    const phase4Start = SKILL_BODY.indexOf("### Phase 4:")
    expect(phase4Start).toBeGreaterThan(-1)
    const phase4Region = SKILL_BODY.slice(phase4Start)
    // Match `gh pr list` invocations (those that include flags/arguments,
    // identified by the `--search` flag we always pass) and require a state
    // flag on each. A bare prose mention of `gh pr list` without arguments
    // is not an invocation and is exempt.
    const ghPrListInvocations =
      phase4Region.match(/gh pr list[^\n`]*--search[^\n`]*/g) ?? []
    expect(ghPrListInvocations.length).toBeGreaterThan(0)
    for (const inv of ghPrListInvocations) {
      expect(inv).toMatch(/--state (all|merged)/)
    }
  })

  test("dispatch_base_branch default uses --short to return a bare branch name", () => {
    // `git symbolic-ref refs/remotes/origin/HEAD` without --short returns the
    // full ref path (refs/remotes/origin/main) rather than the bare branch
    // name (main). That value gets propagated into dispatch metadata / agent
    // prompt instructions where a plain branch name is expected, breaking
    // PR-target instructions in dispatched workspaces.
    const phase0Start = SKILL_BODY.indexOf("### Phase 0:")
    const phase1Start = SKILL_BODY.indexOf("### Phase 1:")
    expect(phase0Start).toBeGreaterThan(-1)
    expect(phase1Start).toBeGreaterThan(phase0Start)
    const phase0Region = SKILL_BODY.slice(phase0Start, phase1Start)
    // Every `git symbolic-ref ... refs/remotes/origin/HEAD` invocation in
    // Phase 0 must include the --short flag.
    const symbolicRefMatches =
      phase0Region.match(/git symbolic-ref[^`\n]*refs\/remotes\/origin\/HEAD/g) ??
      []
    expect(symbolicRefMatches.length).toBeGreaterThan(0)
    for (const inv of symbolicRefMatches) {
      expect(inv).toContain("--short")
    }
  })
})

describe("conductor-notes.md documents key Conductor behavior", () => {
  const requiredHeadings = [
    "Issue-to-workspace lifecycle",
    "Startup scripts",
    "Worktree and branch management",
    "Agent configuration",
    "PR lifecycle",
    "API and CLI",
  ]

  for (const heading of requiredHeadings) {
    test(`conductor-notes.md covers '${heading}'`, () => {
      expect(CONDUCTOR_NOTES_BODY).toContain(heading)
    })
  }
})
