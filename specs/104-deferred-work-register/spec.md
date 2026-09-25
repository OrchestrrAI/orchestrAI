---
id: 104-deferred-work-register
title: Deferred Work Register — Known Gaps Not Yet Specced
area: spec-governance
change_type: governance
status: approved
verification: not-applicable
created: 2026-09-20
updated: 2026-09-22
approved_by: Yusuf
approved_on: 2026-09-20
implemented_on: null
amends: []
related:
  - 078-capability-upgrade-roadmap
  - 079-phase-a-connect-orphaned-tools
  - 085-multi-ecosystem-dependency-audit
  - 099-tui-port-url-and-analyze-project-stack-awareness
  - 100-document-api-grounded-llm-route-discovery-fallback
  - 101-per-agent-tool-access-expansion
  - 102-orchestrator-readonly-project-inspection
  - 103-deep-project-analysis
  - 105-orchestrator-fallback-deep-analysis
  - 106-persistence-store-and-result-cache
  - 107-task-and-conversation-history
  - 108-durable-audit-trail
  - 109-document-api-drift-recheck
  - 110-approval-state-survives-a-restart
  - 111-testing-documentation-routing-fixes
  - 112-plan-step-no-agent-inspection-fallback
supersedes: []
superseded_by: []
---

# Spec: Deferred Work Register — Known Gaps Not Yet Specced

> Status: **DRAFT — awaiting review.** Governance only: this spec changes
> no runtime behavior and implements nothing. It exists because a real
> request was lost. Yusuf, 2026-09-20, after discovering that his own
> opening ask of that session ("the analization … should be more and more
> deep into the code base") had been scoped away into `specs/101`/`102`
> without ever being addressed: *"don't know what to do to keep the
> upcoming tasks or planning so not losing them."*
>
> `specs/078` established the pattern this follows — a `governance` spec
> that decides **ordering and principles only**, where each item becomes
> its own numbered spec requiring its own approval before any code is
> written. `078` covered one planned programme (Phases A–F, now complete).
> This one is the standing register for everything else.

## Why this exists

Deferred items in this repository are currently recorded inside the
**Non-Goals section of whichever spec deferred them**. That is honest and
precise, and it should continue — but it scatters open work across 100+
spec files with no single place to look. The concrete failure case: a
direct, clearly-stated user request was narrowed during design into two
adjacent specs, both of which shipped and were verified, leaving the
original request neither done nor visibly open anywhere. Nothing was
hidden; it was simply not written down in a place anyone would look.

This register is that place.

## What this register is, and is not

- **It is** a list of known, real, verified-against-code gaps that no
  approved spec currently covers.
- **It is not** authorization to implement any of them. Each item still
  needs its own numbered spec and its own explicit approval, exactly as
  `CLAUDE.md`'s working procedure requires.
- **It is not** a priority commitment. Ordering here reflects assessed
  risk and readiness, not a schedule.
- **It does not** replace per-spec Non-Goals sections, which remain the
  authoritative record of why a specific spec deferred a specific thing.

## Register maintenance rule

An item **enters** this register when it is deferred by an approved spec,
or found during verification and not fixed in the same work unit. An item
**leaves** when its own spec reaches `status: implemented` — the entry is
then marked closed with that spec's number, never deleted, so the
reasoning trail survives. A material change to this register returns it
to `draft` for re-approval, same as any other spec.

## A. Open items — candidates for their own spec

Each verified against live code on 2026-09-20 unless noted.

**Re-verified against live code on 2026-09-22, following `specs/105`
through `specs/110`.** None of that work closed or superseded any item
below beyond what's already marked (A8 by `specs/109`; A11 partially by
`specs/105`) — those five specs simply never touched the files these
items describe. Three items (A1, A2, A3) had line citations that had
drifted from unrelated edits elsewhere in the same files, corrected in
place below; A10's own file had moved. No item's risk rating or "still
open" verdict changed.

### A1. `DOCUMENT_API_ENTRY_CANDIDATES` has no grounded fallback

`packages/agents/documentation/index.ts:295-300` (the list itself;
`resolveDocumentApiTarget()`, the function that walks it, is at
`:302-326`). When no explicit source
path is given, `document-api` tries a fixed 8-entry, `.ts`-only list of
conventional filenames and fails closed if none match. A non-JS/TS project
therefore always requires an explicit path. Directly analogous to the gap
`specs/100` just closed one layer down (the route regex), and the
cleanest remaining match for that same deterministic-first, grounded
fallback shape. **Risk: low** — read-only, no approval surface, same agent
and harness already exist.

### A2. Ambiguous test-runner detection never attempts resolution — **closed (narrowed scope) by `specs/111`, 2026-09-22**

`detectRunner()` returns `{kind: "ambiguous"}` when two conflicting
signals of the same kind are found (two lockfiles, or two framework
configs). Both call sites —
`packages/agents/testing/index.ts:458` (`write-tests`) and `:587`
(`run-tests`/`check-coverage`) — stop immediately and ask for
resubmission, with **no LLM attempt at all**, even though the adjacent
`{kind: "unsupported"}` branch already routes through Testing's harness
(`specs/080`). The mechanism to disambiguate from real file evidence
already exists and is simply not reached for this case. **Risk: low** —
the resulting command still passes through the unchanged approval gate.

**Scope correction, 2026-09-22, found while grounding a follow-up
conversation about this exact item, not by re-reading `specs/104`
itself but by re-reading `specs/081`.** The `write-tests` call site
above is **not actually part of this gap** — `specs/081`'s own text
explicitly decided that teaching that harness to also guess a framework
(on top of authoring the test content itself) compounds two guesses in
one step, and left it out on purpose ("teaching it to also guess a
framework for an unknown stack is explicitly deferred"). That is a
considered non-goal, not an oversight matching this item's own
description. The real, well-scoped target is only the `run-tests`/
`check-coverage` call site (`:587`): its own *adjacent* `"unsupported"`
branch already proves the harness-resolution pattern is safe
(`handleUnsupportedRunner()`, `specs/080`) and simply isn't reused for
`"ambiguous"` — a smaller, single-call-site fix, not the two-call-site
one this item's original wording implied.

**Closed by `specs/111-testing-documentation-routing-fixes/spec.md`**
(implemented, verified, 2026-09-22), scoped exactly to the narrowing
above: the `run-tests`/`check-coverage` call site now calls
`handleUnsupportedRunner()` when an explicit command is already in the
text or the harness is genuinely on (guarded against that function's
own harness-off state producing a misleading "no tests configured"
message for a project that plainly has tests). `write-tests`'s own
ambiguous handling remains exactly as `specs/081` left it — untouched,
by design, not by oversight. Live-verified: a real ambiguous npm/pnpm
project, harness on, produced a real model-proposed `["npm", "test"]`
resolution instead of the old static "resubmit" report. See that
spec's own `verification.md` for the full transcript.

### A3. Security's fixed detection lists have no evidence-driven widening

`packages/agents/security/index.ts:228` (`PLACEHOLDER_VALUES`, a
hardcoded 7-value set silently skipped during scanning) and `:329`
(`REQUIRED_GITIGNORE_PATTERNS`, a fixed 7-pattern universal list).
`specs/043`'s AI commentary already annotates *around* these — flagging a
placeholder-shaped value the set missed, or suggesting a project-specific
gitignore entry — but only as prose; it never changes what is scanned or
what counts as a finding. **Risk: medium, and bounded deliberately** —
any future spec here must preserve `specs/043`'s core property that the
model may comment on findings but never create, remove, or downgrade one.

### A4. DevOps write templates are parameter-only by design

**Resolved by `specs/138`** (2026-09-25): the templates are deleted; the model
authors the files, validated after authoring (allow-listed images and
actions, structural checks) before the approval preview.

`packages/mcp/index.ts` — `create_dockerfile`, `create_github_action`,
`create_dockercompose`, `create_gitignore` are fixed template generators;
their schemas accept only structured parameters (`app_type`, `port`,
`include_docker`, `services`, `project_type`, `extras`) and no free-text
content field exists in any of them. DevOps's harness (`specs/042`)
decides only those parameters, never the file's content — a deliberate,
stated choice because this output is **executed** (`docker build`, a real
CI pipeline), unlike documentation which is read.

Yusuf has explicitly asked to revisit this (*"one of the things i really
need to work with it … why will need a template we can right just the
needed docker file for it"*), and the underlying limitation is real: a
fixed template cannot express multi-stage builds, unusual frameworks, or
layouts outside the handful of supported `app_type`s.

**Risk: high — this is a new risk class, not an enhancement.** It needs
its own spec with a genuine safety design, because `specs/100`'s
grounding trick does not transfer: a freshly authored file has no
existing content to ground against. Directions that spec would need to
choose between, none yet decided: an allow-list of permitted base images;
post-generation structural validation (extending what `lint_ci_workflow`
already does for CI output); or keeping template *structure* fixed while
widening the model-filled regions well beyond a single parameter. Ranked
last here for readiness, not importance.

### A5. Coder cannot verify its own edit — **closed by `specs/119`** (`edit-and-verify`)

`specs/101` Non-Goals. Coder proposes an anchored edit, a human approves
it, it is written — and nothing checks that the result still builds or
passes tests. Granting `run_command`/`run_tests` would close that loop but
grants a new approval-gated execution capability to an agent that
currently has none. **Risk: high** — own spec, per `specs/078`'s ordering
rule.

### A6. Three components disagree on a duplicated skill id

`specs/101` documented this and deliberately left it unreconciled:
`normalizeAgentCapabilities()` refuses globally (killing the entire
capability snapshot), `findAgentForSkill()` silently first-match-wins by
registry order, and `validateSelectedSkillOwnership()` permits it
entirely. `specs/101`'s collision test plus the `/healthz`
`capabilities` field make a real collision *visible*, so this is
contained, not urgent — but three different answers to one question is a
latent correctness gap. **Risk: medium.**

### A7. `dispatchPlanStep()` has its own separate no-agent handling — **closed by `specs/112`, 2026-09-22**

`specs/102` Non-Goals. `dispatchRootTask()` gained an inspection fallback
for a skill with no online agent; `dispatchPlanStep()` — a genuinely
separate function — still just marks the step failed. A plan step the
supervisor actually dispatches for a skill nobody owns fails, even where
the Orchestrator could now answer it directly. **Risk: low.**

**Closed by `specs/112-plan-step-no-agent-inspection-fallback/spec.md`**
(implemented, **partial** verification, 2026-09-22): `dispatchPlanStep()`'s
own `!agent` branch now synthesizes a real child task for
`INSPECTION_FALLBACK_SKILLS` skills, exactly mirroring
`dispatchRootTask()`'s own fallback. A full trace before implementing
found the fix genuinely contained to that one branch — every downstream
consumer (`buildOrchestratorSupervisorDeps()`'s own `dispatch()`
wrapper, `waitForChildTask()`, `classifyDispatchOutcome()`,
`composeSupervisorResult()`) is already generic over "any real child
task," so none needed to change. Unit-tested end to end, including the
asynchronous fire-and-forget resolution and failure paths. **The one
open item**: the live pass this spec's own Verification Plan named as
decisive (a real `plan-task` run, the Orchestrator genuinely alone) was
attempted and abandoned mid-attempt — starting a scratch Orchestrator
process directly discovered the user's own real, currently-running
agent stack instead of running in isolation, and continuing down that
path risked interfering with active work, so it was stopped rather than
pushed through. See that spec's own `verification.md` for the full
record.

### A8. Documentation's write path never adopted the post-approval drift recheck — **closed by `specs/109`, 2026-09-22**

Found while grounding `specs/081` and left unfixed there: DevOps's write
skills (`specs/056`) re-verify a content fingerprint immediately before
writing and refuse if the target changed after approval;
`packages/agents/documentation/index.ts` has no
`computeContentFingerprint`/`classifyWritePreflight` call anywhere.
`generate-readme`/`document-api` therefore still carry the narrower
`specs/040` guarantee (preview-to-approval) without the stronger
`specs/056` one (approval-to-write). **Risk: medium** — a real, narrow
window on a real write path.

**Closed by `specs/109-document-api-drift-recheck/spec.md`** (implemented,
verified, 2026-09-22), drafted as a direct prerequisite for
`specs/110`'s own approval-state-persistence work. That spec also found
and fixed a second, previously-untracked gap in the same code:
`document-api`'s own branch never fetched the target's existing content
at preview time at all, so `overwrite`/`previousContent` were always
wrong for a real overwrite. See that spec's own `verification.md` for
the live-verified drift-refusal transcript, both skills.

### A9. `document-api`'s harness is unreachable from a read-only request — **closed by `specs/111`, 2026-09-22**

Found live during `specs/100`'s own verification, out of that spec's
scope. `processTask()` routes `document-api` through
`computeApiDocOrHarness()` **only** when the task text also asks to save
the output (`isWriteApi`); a bare read-only request calls
`computeApiDoc()` directly and never reaches the harness — including
`specs/100`'s new route-discovery fallback — regardless of harness state.
So the same PHP file yields a real analysis when asked to be saved, and
"No Hono route registrations found" when merely asked about.
**Risk: low**, but a genuinely confusing inconsistency.

**Closed by `specs/111-testing-documentation-routing-fixes/spec.md`**
(implemented, verified, 2026-09-22): `skillDocumentApi()` now calls
`computeApiDocOrHarness()` instead of the purely deterministic
`computeApiDoc()`, so a bare read-only request reaches the same harness
(and `specs/100`'s own route-discovery fallback) a "save to" request
already did — one function body changed, no new call site. Live-verified
against a real scratch PHP file with no JS/TS entry: harness on produced
real, grounded documentation for all three real routes; harness off
reproduced the exact pre-fix "No Hono route registrations found" text,
byte-identical. See that spec's own `verification.md` for the full
transcript, including the honest note that no permanent `bun test` case
covers this specific fix (the same real-MCP-dependency constraint
`approval-content.test.ts`'s own header comment already documents for
this agent) — proven live instead.

### A10. Dependency auditing still misses three named ecosystems

`specs/085`'s own stated next steps: Rust (`Cargo.toml`), .NET (NuGet),
and Ruby (`Gemfile`). The parsing-and-OSV-lookup mechanism is proven for
five ecosystems; these are additive, one at a time, same discipline.
**Risk: low.**

**Citation correction, 2026-09-22**: `Ecosystem`/`detectEcosystem()` have
since moved to `packages/shared/detect-ecosystem.ts` (`specs/099`
promoted them out of the security agent so `analyze-project` could also
report the right manifest/lockfile pair) — currently `"npm" | "PyPI" |
"Go" | "Packagist" | "Maven"`, still missing Rust/.NET/Ruby exactly as
described. `packages/agents/security/dependency-manifests.ts` now just
re-exports the same four names unchanged, so a future spec here should
cite the shared module, not the security agent file.

### A11. Deep project analysis is reachable from DevOps only — **partly closed by `specs/119`** (Code Review grounds `review-diff` in the shared analysis; no direct deep-report skill outside DevOps yet)

Raised by Yusuf while `specs/103` was being scoped, deliberately deferred
out of that spec rather than folded in silently: `specs/103` deepens
exactly one skill, DevOps's own `analyze-project` — it cannot be
duplicated onto another agent as the same skill id
(`specs/101`'s single-owner rule). Code Review/Coder/Testing/Documentation
can already *reach for* project-wide context inside their own narrow
jobs (`specs/101`'s tool widening), and the Orchestrator's own inspection
(`specs/102`) deliberately stays shallow since it grounds every plan. But
nothing today lets a user ask, say, the Code Review agent or the
Orchestrator directly for the same kind of deep, general-purpose
structural report `specs/103` gives DevOps.

This traces directly back to Yusuf's original ask at the start of the
2026-09-20 session — *"it should not run only from the devops the orch
should can run it or the code revewier or the coder agent"* — and remains
only partially addressed by `specs/103`. A future spec here would need to
resolve: a second, differently-named skill id exposing the same
capability from another agent (avoids the ownership collision, but two
near-synonymous skill ids may make the LLM router's single-skill choice
less reliable — `specs/054`/`065`'s own stated risk); or a genuinely
shared, tool-shaped capability multiple harnesses can invoke internally,
which is a bigger, more novel design than anything else in this register.
**Risk: medium** — real user-facing gap, but the mechanism to close it
cleanly is not yet obvious and needs its own design pass, not a quick
patch.

**Partially closed, 2026-09-22, by `specs/105-orchestrator-fallback-
deep-analysis/spec.md` (implemented, verified).** That spec resolved the
"one shared, tool-shaped capability" direction named above for exactly
one additional caller: the Orchestrator itself, moving the
implementation into `packages/shared/project-analysis.ts` so DevOps and
the Orchestrator both import ONE copy. This closes the specific case
Yusuf raised the same day ("i need now a solution so i can use this
analysize full feature even if the devops is off") — **not** the
broader "Code Review or Coder agent" half of the original quote above.
Those two (and Documentation) can still only *reach for* project context
inside their own narrow jobs (`specs/101`), never request a dedicated
report — this narrower remainder stays open, **downgraded to low risk**:
the shared module now exists specifically so wiring any of them in later
is one import line plus a judgement call about whether that agent's job
benefits from the context, not a design problem to re-solve.

## B. Explicitly not candidates — do not loosen

Recorded here so a future reader does not mistake their fixedness for an
oversight. Both were reviewed on 2026-09-20 and deliberately excluded.

### B1. `run_command`'s denylist

`checkRunCommandDenylist()`, `packages/mcp/index.ts`. A small hardcoded
pattern list (`rm -rf /`, fork bomb, `mkfs`, `dd if=`) that is explicitly
**defense-in-depth, not the safety mechanism** — the real mechanism is
per-invocation human approval of an exact argv, with no auto-approve, no
batch approval, and no trusted-command memory, ever. Making this list
model-influenced would replace a blunt, predictable backstop with a
probabilistic one.

### B2. `SKILL_TIER_REGISTRY`

`apps/orchestrator/supervisor-graph.ts`. The read-only/write-capable
classification, fail-closed by default (an unregistered skill is treated
as write-capable). The entire approval gate, and the supervisor's own
rule that only a read-only failure permits adaptation, rest on this being
deterministic. A model may freely *propose* any skill; whether that
proposal requires human approval before executing is decided in code and
must stay that way.

**The general principle both express:** the model proposes, code decides
whether the proposal executes. Any future spec that blurs that boundary
needs to argue against this entry explicitly rather than around it.

## C. Standing verification gaps

Not work items — environment limitations, already recorded in `CLAUDE.md`
and the relevant specs' own verification records. Listed here only so they
are not mistaken for unspecced work:

- Real-terminal TUI passes (no raw-mode stdin in the implementing
  sandbox) — carried by every TUI and guided-init checkpoint.
- Clean interactive `Ctrl+C`/SIGINT shutdown verification (Windows
  `Stop-Process` does not deliver a real SIGINT).
- A confirmed green `ci.yml` run exercising the real repository
  `ORCHESTRAI_LLM_API_KEY` secret (`specs/065`).

## Acceptance criteria

- [ ] Every open item in section A names a real file or function,
      verified against live code, with its risk assessed.
- [ ] Every item deferred by an approved spec's Non-Goals as of
      2026-09-20 is either listed here or consciously excluded with a
      reason.
- [ ] `bun run specs:catalog` / `bun run specs:check` pass.
- [ ] No runtime file is modified by this spec.

## Non-goals

- Implementing any listed item.
- Prioritising or scheduling them beyond the readiness ordering given.
- Replacing per-spec Non-Goals sections.
- Tracking bugs found and fixed within a single work unit — those belong
  in `context/worklog.md`, not here.
