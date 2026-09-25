# Verification: LLM-Only Skill Routing

Implemented 2026-09-10. `status: implemented`, `verification: partial` —
two things are open: a live routing pass against a real provider key, and
`ci.yml`'s smoke test (which now needs a repository secret only Yusuf can
add). Everything testable without a real credential is done and green.

## What changed

- `apps/orchestrator/index.ts`: `detectSkill()` is now
  `tryCapabilityRoute(...) ?? "plan-task"` — the keyword ladder, the
  `classifyIntent()` call, the `CI_WORD` constant, and the
  `classifyIntent` import are all deleted. `buildCapabilitySnapshot()`
  always appends a synthetic `{agentName: "orchestrator", skillId:
  "suggest-agents"}` source so the router can name that meta-skill.
- `packages/shared/agent-capabilities.ts`: `EXCLUDED_SKILL_IDS` dropped
  `"suggest-agents"` (kept `"plan-task"`). Checked directly before
  changing it: `normalizeAgentCapabilities()` has exactly one real
  caller (`buildCapabilitySnapshot()` → `detectSkill()`'s router), not
  shared with the adaptive supervisor's own plan-step catalog, so
  un-excluding `suggest-agents` only ever makes it nameable by the
  router, never reachable as a recursive plan step.
- `packages/shared/capability-router.ts`: the system prompt no longer
  claims it's "consulted only after keyword matching and a local
  semantic classifier both found no confident match" — both tiers are
  gone; it's the only routing mechanism now.
- `.github/workflows/ci.yml`: the dispatch smoke test reads
  `ORCHESTRAI_LLM_API_KEY` from `${{ secrets.ORCHESTRAI_LLM_API_KEY }}`
  instead of a hardcoded fake value.
- Test files: `detect-skill.test.ts` fully rewritten for the single-tier
  shape; `capability-router-detect-skill.test.ts` updated (its "never
  consulted when a keyword match exists" test is now false — replaced
  with "every request reaches the router now"), plus two new tests for
  the `suggest-agents` meta-skill. `agent-capabilities.test.ts` and
  `skill-dispatch.test.ts` updated for the exclusion/snapshot changes.
- **`apps/orchestrator/keyword-router-fake.ts`** (new, test support) —
  see the regression below.

## The 51-minute regression this surfaced, and the fix

The first full `bun test` run after removing the keyword tier took
**51 minutes** (normally ~25 seconds). Root cause, confirmed directly:
several test files unrelated to routing —
`apps/orchestrator/supervisor-wiring.test.ts`,
`ask-endpoint.test.ts` — set `process.env.ORCHESTRAI_LLM_API_KEY =
"fake-key"` for their own purposes (testing dispatch wiring, tier
classification), with one of them literally commenting the value
`"unused-should-never-be-read-for-this-request"`. That invariant was
true while keyword matching existed. With every request now routed
through the LLM router, those tests' fake keys resolved as
syntactically valid, `buildChatModel()` constructed a real provider
client, and `runCapabilityRouter()` made **real outbound HTTP calls**
that failed and retried with `specs/055`'s own backoff — repeated across
the suite.

This was flagged to Yusuf as a materially larger cost than the spec's
own Safety section anticipated (it scoped a fix only for `ci.yml`'s one
dedicated smoke test, not the rest of the suite). Yusuf chose: make
every affected test inject a fake model.

Fix: a `__setTestRouterModel()` seam on `apps/orchestrator/index.ts`
(read by `detectSkill()` when no `deps.model` is passed, so it covers
the `POST /tasks` and `/ask` paths without touching either call site),
plus `KeywordRouterFake` — a `BaseChatModel` that reproduces the exact
keyword decisions `detectSkill()` used to make, wrapped as a router
proposal. Affected test files set it in `beforeEach`, clear it in
`afterEach`. Their existing skill assertions pass unchanged,
hermetically, with no network call. The router's own real
proposal/validation/fail-closed behavior is still covered separately by
`capability-router-detect-skill.test.ts` with scripted fakes.

## Verification performed

- `bun run typecheck` — 0 errors.
- `bun test` — 852 pass, 0 fail, 1658 expect() across 57 files, **~25s**
  (regression fixed). Count is down from the pre-065 877 because the old
  keyword/classifier `test.each` cases in the two rewritten routing
  files are gone.
- `bun run specs:catalog`/`specs:check` — pass, 65 specs.

## What's not verified here

1. **A live routing pass against a real provider key.** No real LLM
   call has been made — every test injects a fake model. The same gap
   every prior LLM checkpoint in this codebase has needed Yusuf's own
   credentials to close.
2. **`ci.yml`'s smoke test.** It now reads a repository secret that does
   not exist yet. Adding it (GitHub → Settings → Secrets and variables →
   Actions) is an operational step outside this repo's code. Until then,
   that CI step's `suggest-agents` check fails — expected and correct
   per this spec's own Acceptance Criteria, not a code regression.

## Behavior changes worth knowing

- With no key configured, **every** natural-language request now resolves
  to `plan-task` (including "what agents do you have"), which itself
  fails closed with its existing named error. Deliberate, stated in the
  spec's Proposed Behavior.
- A skill with no online agent is no longer nameable by the router, so
  the "No agent found for skill X" error path is unreachable for an
  offline skill — such a request falls through to `plan-task` instead.
  One `ask-endpoint.test.ts` test that asserted the old error path was
  updated to reflect this.

## Update 2026-09-10 — live Gemini routing pass

Started the real headless stack from `test-target-project` (real Gemini
key in its `.orchestrai/config.env`) and submitted two real
`POST /tasks` requests:

- `"what agents do you have available"` →
  `{"assignedAgent":"orchestrator","skill":"suggest-agents","status":
  "completed"}` — the router named the new synthetic meta-skill and it
  completed synchronously, exactly the shape `ci.yml`'s smoke test
  checks.
- `"show me the git status of this repo"` → `git-status` → `devops-agent`.

Router log clean. This closes the core live-routing acceptance criterion.
Still open: a confirmed green `ci.yml` run (the secret was added by Yusuf
2026-09-10 but no push has exercised it yet), and Anthropic/OpenAI
routing (Gemini only this session).

## Update 2026-09-14 — a second live pass, plus a real non-determinism finding

A second live pass, same session as specs/055/060's own 2026-09-14 live
attempts (bare-metal `mcp:http` + `devops-agent` + `orchestrator`, real
Gemini key), re-confirmed the core claim and surfaced one new, real
finding worth recording rather than glossing over.

**Re-confirmed**: `"check the git status at <path>"` →
`{"assignedAgent":"devops-agent","skill":"git-status"}`, completed with
a real, correct result (`Branch: master`, a real modified file, a real
commit log). `"analyze the project ... at <path>"` (as part of a
longer combined phrasing) → `{"assignedAgent":"devops-agent","skill":
"analyze-project"}`, completed with a real, correct project analysis
including the real DevOps-to-Security A2A pre-check correctly
fail-opening (Security wasn't running in this reduced stack).

**A real, live-observed non-determinism finding**: the *exact same*
request text (`"check the git status at <path>"`, byte-identical,
resubmitted as a fresh task) resolved differently across two separate
calls — the first time directly to `git-status`/`devops-agent`
(`isPlan: false`), the second time to `plan-task`/
`orchestrator-supervisor` (`isPlan: true`). This is expected,
inherent behavior for an LLM-based router (the same input can
legitimately produce a different output across calls) — not a bug in
this codebase's own logic — but it is worth recording plainly as a real
property this router has, confirmed by direct observation rather than
assumed from how LLMs work in general. Neither `specs/054` nor
`specs/065`'s own spec text names this as an explicit, expected
behavior; it's recorded here as a live finding for anyone reasoning
about this router's reliability going forward.

This closes no new open item on its own (the core live-routing claim
was already closed by the 2026-09-10 pass above), but adds a second,
independent real confirmation plus the non-determinism finding.

## Update 2026-09-15 — the spec's own named phrases confirmed, plus the adversarial fall-through case

The spec's own Verification Plan explicitly named three representative
phrases to confirm live: `"dockerize my app"`, `"scan for secrets"`,
`"what agents do you have"`. The third was already closed by the
2026-09-10 pass above; the first two had not been run with this exact
wording before. All three, run against the real, restarted bare-metal
stack (real Gemini key):

- `"dockerize my app at <path>"` → `{"assignedAgent":"devops-agent",
  "skill":"dockerize","status":"assigned"}` — correct.
- `"scan for secrets in <path>"` → `{"assignedAgent":"security-agent",
  "skill":"scan-secrets","status":"assigned"}` — correct.
- `"what agents do you have"` → `{"assignedAgent":"orchestrator",
  "skill":"suggest-agents","status":"completed"}` — re-confirmed.

**The adversarial fall-through case was also exercised for the first
time**, using a request naming a skill genuinely offered by no agent in
this codebase (`"please translate this document into spanish for me"`):
the router correctly did not hallucinate a `translate` skill or
misroute to an unrelated one — it fell through to
`{"assignedAgent":"orchestrator-supervisor","skill":"plan-task",
"isPlan":true}`, exactly the designed fallback. (The adaptive supervisor
that request then reached made its own separate, expected attempt to
locate a document to translate via `analyze-project`/`run-command`,
surfacing an unrelated reconciliation-required failure — that is
`specs/028`'s own adaptive-supervisor behavior, not a routing defect,
and out of scope for what this spec verifies.)

Every phrase this spec's own Verification Plan named by name is now
live-confirmed. **Still open, unchanged**: a confirmed green `ci.yml`
run exercising the real repository secret — an operational/CI step, not
something this session's sandbox can trigger.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

> **Historical, retired by `specs/065`:** the two paragraphs that follow
> (the semantic fallback, and `specs/054`'s "third, strictly subordinate
> routing tier") describe the three-tier routing ladder — keyword first,
> local classifier second, LLM router third — that `detectSkill()` used
> before `specs/065-llm-only-skill-routing/spec.md` deleted the first
> two. They are kept for the reasoning trail (why the tiers existed, the
> thresholds, the footgun each guarded). The router they describe as
> "third, strictly subordinate" is now the *only* tier. `specs/054`'s
> own live-verification gap is subsumed by `specs/065`'s.

### The LLM router is now the only routing tier (`specs/065`)

`specs/065-llm-only-skill-routing/spec.md` (implemented, **partial**
verification, 2026-09-10) promoted `specs/054`'s router from "third
tier, subordinate" to the *only* way `detectSkill()` names a skill.
`detectSkill()` is now `tryCapabilityRoute(...) ?? "plan-task"`; the
keyword ladder, `classifyIntent()`, and `CI_WORD` are deleted from the
path. `buildCapabilitySnapshot()` always appends a synthetic
`{agentName: "orchestrator", skillId: "suggest-agents"}` source (and
`normalizeAgentCapabilities()`'s `EXCLUDED_SKILL_IDS` dropped
`"suggest-agents"`, keeping only `"plan-task"`) so the router can still
name that meta-skill — checked directly that `normalizeAgentCapabilities()`
has exactly one real caller (this router), not shared with the adaptive
supervisor's own plan-step catalog, so this can't cause a recursive
plan step. Deliberate, approved consequences: every request costs a
real provider call; with no key, everything → `plan-task` → its own
fail-closed error; an offline skill is unnameable, so its request →
`plan-task` rather than a "no agent for skill" error.

**A 51-minute test-suite regression surfaced and was fixed during this
work, not assumed away.** Removing the keyword tier meant every
text-dispatch test path went through a real router call — and several
test files (`supervisor-wiring.test.ts`, `ask-endpoint.test.ts`) set a
syntactically-valid *fake* `ORCHESTRAI_LLM_API_KEY` for their own
unrelated purposes (one literally comments the value
`"unused-should-never-be-read-for-this-request"`). Those fakes now
triggered real outbound HTTP calls that failed and retried with
`specs/055`'s backoff, across the suite. Flagged to Yusuf as a bigger
cost than the spec anticipated; his call: inject a fake model
everywhere affected. Fixed with a `__setTestRouterModel()` seam on
`apps/orchestrator/index.ts` (read by `detectSkill()` when no
`deps.model` is passed) plus `apps/orchestrator/keyword-router-fake.ts`
— a `BaseChatModel` reproducing the exact old keyword decisions as
router proposals, so dispatch-wiring/tier-classification tests keep
their existing skill assertions, hermetically. `bun test` back to ~25s,
852 pass / 0 fail.

**Closed live, 2026-09-10 and re-confirmed 2026-09-14/2026-09-15**: real
Gemini dispatches for `"what agents do you have"`, `"show me the git
status of this repo"`, `"dockerize my app"`, and `"scan for secrets"`
each routed correctly; the adversarial fall-through case (a skill no
agent offers) correctly fell through to `plan-task` rather than
hallucinating. A real, live-observed non-determinism finding was also
recorded: the exact same request text resolved differently
(`git-status` directly vs. `plan-task`) across two separate live calls
— expected, inherent LLM-router behavior, not a bug. See that spec's
own `verification.md` for the full transcript. **Still open**: a
confirmed green `ci.yml` run exercising the real `${{ secrets.
ORCHESTRAI_LLM_API_KEY }}` repository secret — an operational CI step,
not something reproducible from this sandbox; `verification` stays
`partial` for this reason alone.

See specs/054-capability-driven-llm-routing/verification.md for the relocated narrative covering this checkpoint.

See specs/096-router-multi-concern-request-detection/verification.md for the relocated narrative covering this checkpoint.

See specs/105-orchestrator-fallback-deep-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/093-conversation-answer-context-blind/verification.md for the relocated narrative covering this checkpoint.

See specs/075-real-conversational-chat/verification.md for the relocated narrative covering this checkpoint.

See specs/102-orchestrator-readonly-project-inspection/verification.md for the relocated narrative covering this checkpoint.
