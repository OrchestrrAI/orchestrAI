---
id: 008-routing-fixes
title: Orchestrator and Planning Routing Fixes for Documentation and Security
area: routing-planning
change_type: fix
status: implemented
verification: verified
created: 2026-08-08
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-08
implemented_on: 2026-08-08
amends: []
supersedes: []
superseded_by: []
related:
  - 002-documentation-agent
  - 015-routing-planning-polish-2
  - 003-security-agent
---

# Spec: Orchestrator and Planning Routing Fixes for Documentation and Security

> Status: **APPROVED by Yusuf on 2026-08-08 — Decision 1: Option B for
> Planning. Decision 2: Option (a), implement `create-compose`. IMPLEMENTED
> and VERIFIED on 2026-08-08; results recorded in Verification Results
> below.**

## Purpose

Documentation and Security agents are fully implemented, tested, and reachable
directly (their own dashboards, direct HTTP calls) — but completely
unreachable through the Orchestrator, the primary demo surface. This is two
stacked gaps, both of which must close together:

1. Orchestrator's `detectSkill()` has no keywords that resolve to a
   Documentation or Security skill ID.
2. Planning Agent's `skillPlanTask()` never emits a Documentation or Security
   step, regardless of input wording.

Fixing only #1 fixes direct one-shot requests (`"scan secrets"` typed into the
Orchestrator) but not multi-step plans — a plan for `"prepare everything for
production"` would still silently skip a security scan. Fixing only #2 is
moot if a direct request never reaches Planning in the first place. This spec
covers both, plus the pre-existing `create-compose` dead-code question,
which affects the safest way to extend the same `detectSkill()` function.

## Verified Current Behavior

### Confirmed skill IDs (from each agent's live `agentCard`, not guessed)

| Agent | Port | Skill IDs |
|---|---|---|
| DevOps | 3002 | `dockerize`, `create-ci`, `create-gitignore`, `analyze-project`, `git-status` |
| Testing | 3003 | `run-tests`, `check-coverage` |
| Documentation | 3004 | `generate-readme`, `document-api` |
| Security | 3005 | `scan-secrets`, `check-gitignore-coverage`, `audit-dependencies` |
| Planning | 3001 | `plan-task`, `suggest-agents` |

`create-compose` does **not** appear in DevOps's `agentCard.skills`
([packages/agents/devops/index.ts:37-44](packages/agents/devops/index.ts)),
even though DevOps's own internal `detectSkill()` recognizes it.

### Orchestrator `detectSkill()` — current ([apps/orchestrator/index.ts:104-124](apps/orchestrator/index.ts:104))

```ts
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("dockerfile") || lower.includes("dockerize")) return "dockerize"
  if (lower.includes("gitignore"))                                  return "create-gitignore"
  if (lower.includes("analyze") || lower.includes("missing"))      return "analyze-project"
  if (lower.includes("git status") || lower.includes("git stat"))  return "git-status"
  if (lower.includes("suggest") || lower.includes("what agent"))   return "suggest-agents"
  if (lower.includes("plan") || lower.includes("build") ||
      lower.includes("deploy") || lower.includes("setup") ||
      lower.includes("prepare") || lower.includes("production"))   return "plan-task"
  if (lower.includes("ci") || lower.includes("pipeline"))          return "create-ci"
  return "plan-task"
}
```

No branch mentions Documentation or Security. `"scan for secrets"`,
`"document the API"`, and `"check gitignore coverage"` (note: this one
already contains the word `"gitignore"` and would currently be misrouted to
DevOps's `create-gitignore` — see Ambiguity Risks below) all fall to the
final `plan-task` default.

### Planning `skillPlanTask()` — current ([packages/agents/planning/index.ts:90-131](packages/agents/planning/index.ts:90))

```ts
async function skillPlanTask(text: string): Promise<string> {
  const lower = text.toLowerCase()
  const steps: string[] = []
  steps.push(`1. [analyze-project] ...`)
  if (docker/deploy/build/container/production) steps.push(`[dockerize] ...`)
  if (ci/deploy/pipeline/production)             steps.push(`[create-ci] ...`)
  if (git/setup/init)      steps.push(`[git-status]`, `[create-gitignore]`)
  if (test/production/deploy)                    steps.push(`[run-tests] ...`)
  ...
}
```

No branch ever emits `[generate-readme]`, `[document-api]`, `[scan-secrets]`,
`[check-gitignore-coverage]`, or `[audit-dependencies]`. `extractAgents()`
([packages/agents/planning/index.ts:67-85](packages/agents/planning/index.ts:67))
already maps those skill IDs to `documentation-agent`/`security-agent`
correctly if they ever appeared in a step line — the only gap is that
`skillPlanTask()` never produces one.

### `create-compose` dead code — confirmed still present, unchanged

- DevOps's own `detectSkill()` routes `"compose"` → `"create-compose"`
  ([packages/agents/devops/index.ts:86](packages/agents/devops/index.ts:86)).
- `NEEDS_APPROVAL` includes it
  ([packages/agents/devops/index.ts:202](packages/agents/devops/index.ts:202)).
- `prepareWriteAction()` has no `"create-compose"` branch, so it falls to the
  generic `{ skill, targetPath: base }` with no `toolName` — approving it
  reaches `resumeTask()`'s fallback, `` `Skill "${skill}" approved but not
  implemented` ``.
- The MCP tool factory already has a working `create_dockercompose` tool
  ([packages/mcp/index.ts:350-385](packages/mcp/index.ts:350)) that takes
  `output_path`, `services[]`, and `include_networks` — DevOps just never
  calls it for this skill.

## Proposed Changes

### 1. Orchestrator `detectSkill()` additions

```ts
function detectSkill(text: string): string {
  const lower = text.toLowerCase()

  // DevOps Agent skills
  if (lower.includes("dockerfile") || lower.includes("dockerize")) return "dockerize"
  if (lower.includes("gitignore") && lower.includes("coverage"))   return "check-gitignore-coverage"  // NEW — must precede the line below
  if (lower.includes("gitignore"))                                  return "create-gitignore"
  if (lower.includes("analyze") || lower.includes("missing"))      return "analyze-project"
  if (lower.includes("git status") || lower.includes("git stat"))  return "git-status"

  // Security Agent skills — NEW
  if (lower.includes("secret"))                                     return "scan-secrets"
  if (lower.includes("audit"))                                      return "audit-dependencies"

  // Documentation Agent skills — NEW (mirrors Documentation Agent's own
  // internal detectSkill() precedence — reuse, don't reinvent)
  if (lower.includes("api") && (lower.includes("document") || lower.includes("doc"))) return "document-api"
  if (lower.includes("readme") || lower.includes("documentation") || lower.includes("docs")) return "generate-readme"

  // Planning Agent skills
  if (lower.includes("suggest") || lower.includes("what agent"))   return "suggest-agents"
  if (lower.includes("plan") || lower.includes("build") ||
      lower.includes("deploy") || lower.includes("setup") ||
      lower.includes("prepare") || lower.includes("production"))   return "plan-task"

  // CI — could be either, default to devops
  if (lower.includes("ci") || lower.includes("pipeline"))          return "create-ci"

  return "plan-task"
}
```

| New keyword | Skill ID | Agent | Approval tier |
|---|---|---|---|
| `secret` | `scan-secrets` | security-agent | Tier 2 (read-only) |
| `audit` | `audit-dependencies` | security-agent | Tier 2 (read-only) |
| `gitignore` + `coverage` (both present) | `check-gitignore-coverage` | security-agent | Tier 2 (read-only) |
| `api` + (`document` or `doc`) | `document-api` | documentation-agent | Tier 2 unless task also says "save to"/"write to" (existing agent-side rule, unchanged) |
| `readme` / `documentation` / `docs` | `generate-readme` | documentation-agent | Tier 1 (write, existing `NEEDS_APPROVAL`) |

Deliberately **not proposed**: a bare `"security"` keyword. Security Agent
has three distinct skills; `"security"` alone doesn't disambiguate which one,
and a wrong guess would be worse than falling through to `plan-task`.

### 2. Planning `skillPlanTask()` additions — two options, recommend Option B

**Option A — reuse existing triggers** (`production`, `setup`, `deploy`
already used by `dockerize`/`create-ci`): add `[scan-secrets]` and
`[generate-readme]` to those same conditions.
- Pro: matches the team's example wording (`"prepare for production"` should
  include a security audit) with no new keywords.
- Con: **changes the step count of already-demoed plans.** The exact plan
  the team walked through this session — `"build and deploy my bun app"` →
  4 steps (`analyze-project`, `dockerize`, `create-ci`, `run-tests`) — would
  grow to 6 steps under this option, changing timing and dashboard behavior
  that's already been shown working. This is a real regression risk to
  something already validated.

**Option B — new, narrower triggers** (recommended): only add
`[scan-secrets]`/`[generate-readme]` when the text itself mentions
security/docs intent, not merely "production"/"setup"/"deploy":

```ts
if (lower.includes("secur") || lower.includes("secret") || lower.includes("audit")) {
  steps.push(`${steps.length + 1}. [scan-secrets] Scan for exposed secrets before shipping`)
}
if (lower.includes("readme") || lower.includes("document") || lower.includes("docs")) {
  steps.push(`${steps.length + 1}. [generate-readme] Generate project documentation`)
}
```

- Pro: `"build and deploy my bun app"` stays exactly 4 steps — zero
  regression to already-demoed behavior. `"prepare a complete project:
  build, deploy, document, and secure it"` now produces 6 steps correctly.
- Con: bare `"prepare for production"` (no explicit mention of docs/security)
  will **not** get those steps, even though the team's example implies it
  should. If judges are expected to say exactly `"prepare for production"`
  and see a security step appear, Option A is required instead — Yusuf/team
  should confirm which behavior the demo script actually needs before this
  is implemented.

### 3. `create-compose` decision — recommend (a) implement

Three options as requested:

**(a) Implement it (recommended).** The hard part — the actual Compose
generation logic — already exists and is already tested as MCP's
`create_dockercompose` tool. The remaining work is small and mirrors the
existing `dockerize` pattern exactly: build a single-service `services[]`
array from the same `extractAppType()`/`extractPort()` helpers already used
by `prepareWriteAction()`, wire it through the same
`pendingAction`/`actionId`/`resumeTask()` flow as the other three write
skills, and add `create-compose` to DevOps's `agentCard.skills`. This turns a
currently-broken, visibly-confusing demo path (approve → "approved but not
implemented") into a fourth working MCP write demo for free, since the tool
was already built and is already covered by the MCP factory's existing
tests.

**(b) Remove the dead code.** Delete the `"compose"` branch from DevOps's
`detectSkill()`, drop `"create-compose"` from `NEEDS_APPROVAL`. Simpler, but
throws away a demo opportunity that's nearly free to finish.

**(c) Keep it dead, document as "planned".** Not recommended — a task that
reaches `input-required`, asks for approval, and then does nothing after
approval is a worse demo experience than the skill not existing at all
(judges may click Approve expecting a file and get confused when nothing
appears).

This spec proposes (a); Yusuf's explicit sign-off on this specific choice is
required before implementation, per the request that started this draft.

## Ambiguity Risks (as requested — documented, not silently resolved)

- **`"secret"` substring risk:** matches inside `"secretary"`. Accepted as a
  low-probability risk for a technical demo audience; flagging rather than
  adding compensating logic (e.g. requiring `"scan"` alongside `"secret"`)
  because the fix would itself add another judgment call. Yusuf's call.
- **`"gitignore"` collision (already exists today, but gets worse):**
  `"check gitignore coverage"` contains the substring `"gitignore"`. The
  proposed fix orders the compound `gitignore`+`coverage` check *before* the
  existing bare `gitignore` check specifically to prevent this — this
  ordering is load-bearing and must not be reordered later without
  re-verifying both cases.
- **`"audit"` alone → `audit-dependencies`:** Security Agent only has one
  audit-shaped skill today, so this is unambiguous now, but will become
  ambiguous the moment a second audit-type skill is added to any agent.
  Flagging for future maintainers, not a reason to block this spec.
- **`"ci"` substring bug (pre-existing, not fixed here):** a directory named
  `...\ci-demo\...` already misroutes to `create-ci` today
  (`context/e2e-validation-2026-08-08.md`). None of the new keywords in this
  spec add a new instance of this problem, but it remains unfixed — it's
  explicitly out of scope below, same as before.
- **`"set up"` (two words) vs `"setup"` (one word):** the existing
  `.includes("setup")` check does **not** match a spaced `"set up"`. The
  team's own example phrasing (`"set up a complete project"`) would not
  trigger the existing `setup` branch at all today, independent of this
  spec's changes. Not fixed here (pre-existing keyword-parsing gap, same
  category as the `"ci"` substring issue) — flagging because it directly
  affects whether Option A or B above behaves as the team expects when using
  that exact phrasing.

## In Scope

1. The `detectSkill()` additions in Orchestrator listed above.
2. One of the two `skillPlanTask()` options above (Yusuf to choose A or B).
3. The `create-compose` decision (Yusuf to confirm (a), (b), or (c)).
4. Updating DevOps's `agentCard.skills` to include `create-compose` if (a) is
   chosen.
5. Regression tests proving existing DevOps/Testing/Planning routing and the
   already-demoed plan step-counts are unchanged (unless Option A is chosen,
   in which case the test documents the new expected count instead).

## Out of Scope

- Converting Testing/Documentation/Security to MCP clients (separate spec,
  `specs/011-remaining-agents-mcp/spec.md`).
- LLM-based routing (separate spec).
- Fixing the pre-existing `"ci"` substring misroute or the `"set up"`
  two-word gap — both noted above, neither introduced or worsened here.
- Fixing the natural-language preposition path-parsing issue — already
  handled in `specs/007-parsing-and-sse-reliability-fixes/spec.md`.
- A full A2A mesh between all agents.
- New MCP tools beyond wiring the existing `create_dockercompose` (only if
  option (a) is chosen for `create-compose`).

## Acceptance Criteria

- [x] Yusuf approves this spec, including explicit choices for: Option A vs.
      B for Planning, and (a)/(b)/(c) for `create-compose`. → **B**, **(a)**.
- [x] Every Documentation Agent skill is reachable via direct Orchestrator
      routing (`generate-readme`, `document-api`) — live-verified.
- [x] Every Security Agent skill is reachable via direct Orchestrator routing
      (`scan-secrets`, `check-gitignore-coverage`, `audit-dependencies`) —
      live-verified.
- [x] `"check gitignore coverage"` routes to Security's
      `check-gitignore-coverage`, not DevOps's `create-gitignore` — live-verified.
- [x] Planning emits Documentation/Security steps per Option B, with a
      regression test locking in the exact step count for
      `"build and deploy my bun app"` (4, unchanged) and
      `"setup my project from scratch"` (3, unchanged) — both unit-tested
      and live-verified.
- [x] Existing DevOps/Testing/Planning/CI routing does not regress — a test
      per existing keyword confirms unchanged resolution
      (`apps/orchestrator/detect-skill.test.ts`).
- [x] The `create-compose` decision is implemented as (a); a live write test
      proved a `docker-compose.yml` is created only after approval, matching
      the existing three DevOps write skills' behavior exactly.
- [x] `bun test` remains fully green — 76 pass, 0 fail, 120 expectations,
      9 files (up from 52/89/7 before this checkpoint).

## Verification Results (2026-08-08)

- `bun test`: **76 pass, 0 fail, 120 expectations, 9 files**. New coverage:
  `apps/orchestrator/detect-skill.test.ts` and
  `packages/agents/planning/skill-plan-task.test.ts`.
- `detectSkill()` (Orchestrator) and `skillPlanTask()` (Planning) were
  `export`ed and their bottom-of-file `serve()`/`startDiscovery()` calls
  guarded with `if (import.meta.main)` so they're unit-testable without
  binding a real port or starting live discovery as an import side effect —
  a real, if minor, testability gap in the existing codebase surfaced while
  writing these tests.
- **Found and fixed during live verification, not caught by the draft's own
  ambiguity-risk review:** the initial implementation placed the new
  Documentation/Security keyword checks *before* the Planning `plan-task`
  trigger check in Orchestrator's `detectSkill()`. This meant
  `"prepare a complete project with docs and security"` — the exact sentence
  from the approval discussion — short-circuited to a single
  `generate-readme` direct action and never reached Planning at all. Fixed
  by reordering the `plan-task` trigger check ahead of the single-skill
  Documentation/Security keywords; regression test added
  (`apps/orchestrator/detect-skill.test.ts`, "a plan trigger combined with
  doc/security wording still goes to plan-task").
- **Noted discrepancy, not a bug:** with the fix in place, the exact sentence
  above now correctly reaches Planning but produces a **3-step** plan
  (`analyze-project`, `scan-secrets`, `generate-readme`), not the "6-step
  plan" mentioned in the approval discussion. The deterministic keyword
  system only adds a step when its own specific trigger words are present;
  that sentence contains security/docs wording but no docker/CI/git/test
  wording, so only 3 of the possible steps fire. This matches the
  system's designed behavior (responds to intent, not a fixed template) —
  flagging so the demo script uses wording that hits every intended step if
  a 6-step plan is the actual goal (e.g. one sentence explicitly mentioning
  build, deploy, test, docs, and security together).
- Live-verified end to end with `bun run dev` and a disposable scratch
  project: `"generate a readme for my project"` and
  `"scan for secrets in my project"` both now route directly to
  documentation-agent/security-agent from the Orchestrator;
  `"check gitignore coverage"` routes to Security, not DevOps;
  `"build and deploy my bun app"` still produces its original 4 steps
  unchanged; `create-compose` reached `input-required` with a correct
  preview, produced no file before approval, and produced a correct
  `docker-compose.yml` only after approval.
- Full stack (ports 3000–3006) and the disposable scratch project were
  cleaned up after verification.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/008-routing-fixes/spec.md with: Option [A/B] for Planning,
option [a/b/c] for create-compose.
```

or list specific changes needed. No implementation is authorized by
discussion of this draft alone.
