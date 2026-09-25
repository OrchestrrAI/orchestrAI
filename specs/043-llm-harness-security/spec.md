---
id: 043-llm-harness-security
title: Opt-in LLM Harness for Security — Additive Commentary, Never a Filter
area: llm-harness
change_type: feature
status: implemented
verification: verified
created: 2026-09-02
updated: 2026-09-02
approved_by: Yusuf
approved_on: 2026-09-02
implemented_on: 2026-09-02
amends: []
supersedes: []
superseded_by: []
related:
  - 011-remaining-agents-mcp
  - 026-llm-harness-langgraph-planning
  - 029-shared-llm-provider-gemini
  - 039-per-component-llm-provider-config
  - 041-llm-harness-documentation
  - 042-llm-harness-devops
---

# Spec: Opt-in LLM Harness for Security — Additive Commentary, Never a Filter

> Status: **APPROVED (pre-approved 2026-09-02, per Yusuf's explicit
> instruction to proceed autonomously through `042`/`043` "with pre
> approval as we talked before about enhancing and increasing the tools
> if needed also") and IMPLEMENTED the same day. VERIFIED the same
> day** — all three skills' enrichment layer built, tested, and
> live-verified against a real Gemini deployment, including the
> decisive test: a deliberately-constructed scratch project exercising
> all three gaps identified in Verified Current State, all three
> correctly caught by the enrichment layer while every deterministic
> finding stayed intact and unfiltered. See Verification Results below.
> This spec is architecturally the most different of the three
> (`041`/`042`/`043`): Security has no write skills and no approval
> gate at all, and stays deliberately direct-`fs`, not an MCP client
> (`specs/011-remaining-agents-mcp/spec.md` decision (c)). Both facts
> change what "opt-in LLM harness" has to mean here — see Proposed
> Behavior below for the resulting design, which deliberately departs
> from `041`/`042`'s literal fail-closed-the-whole-task shape while
> preserving its actual purpose.

## Purpose

`041` gave Documentation's write skills LLM-authored prose, grounded in
already-fetched project content. `042` gave DevOps's write skills
LLM-decided parameters, grounded in already-discovered project facts,
fed into unmodified deterministic templates. Both extended a **write**
path that already had human approval as its safety backstop.

Security has no write path. Its three skills
(`packages/agents/security/index.ts`) are read-only, deterministic scans
that return a text report; no task from this agent ever reaches
`input-required`, and no `resumeTask()`/approval machinery exists for it
at all (confirmed by reading the file end to end — there is no
`NEEDS_APPROVAL` set, no `actionId`, nothing to gate). So the risk this
spec has to manage is not "a wrong write happens" — it's "the report
lies to the person reading it," either by asserting something the model
cannot actually know (a specific CVE, a claim of certainty about
exploitability) or by making a real deterministic finding look resolved
or unimportant when it was neither. Both are worse in a *security* tool
than in Documentation or DevOps, because the entire point of this agent
is to be a source of truth someone leans on when deciding whether
something is safe to ship.

## Verified Current State

Read directly from `packages/agents/security/index.ts` (586 lines, no
prior LLM involvement anywhere in this agent):

- **`scan-secrets`** (`skillScanSecrets`, line 171): walks the project
  tree (excluding `node_modules`/`.git`/`dist`/`build`), regex-matches
  each line against `HIGH_CONFIDENCE_RULES` (well-known key prefixes —
  Anthropic, GitHub, AWS, OpenAI) and `MEDIUM_CONFIDENCE_RULES` (generic
  `key`/`secret`/`password` assignments). A medium-confidence hit is
  skipped only if its value exact-matches one of seven hardcoded
  `PLACEHOLDER_VALUES` (`"your-password-here"`, `"xxx"`, `"changeme"`,
  `"password"`, `"example"`, `"placeholder"`, `"todo"`). **Confirmed
  gap:** any other placeholder-shaped value —
  `"CHANGE_ME_IN_PRODUCTION"`, `"REPLACE_WITH_YOUR_KEY"`,
  `"insert-key-here"`, `"test123"`, `"<your-api-key>"` — is not in that
  set and is reported identically to a real leaked credential. The
  scanner also has zero awareness of *where* a match sits: a hit inside
  `__tests__/fixtures/fake-keys.ts` or a `README.md` code sample is
  flagged with the same confidence label as one inside `src/config.ts`.
- **`check-gitignore-coverage`** (line 231): checks a fixed, hardcoded
  seven-pattern list (`REQUIRED_GITIGNORE_PATTERNS`:
  `.env`, `.env.*`, `node_modules/`, `*.key`, `*.pem`, `dist/`,
  `build/`) against the project's actual `.gitignore`, plus one
  special-cased check for a literal `.env` file's presence. **Confirmed
  gap:** the pattern list is universal, not derived from what is
  actually in the project. A project containing `terraform.tfstate`,
  `.aws/credentials`, `secrets/`, `config/local.json`, or an alternate
  private-key filename (`id_rsa`, `id_ed25519`) gets no signal at all —
  none of those are in the fixed list, and nothing in this skill ever
  looks at what files actually exist beyond the one `.env` special case.
- **`audit-dependencies`** (line 272): parses `package.json`, flags any
  dependency whose declared version is the literal string `"*"` or
  `"latest"`. **Confirmed gap:** this is the shallowest of the three by
  a wide margin — it has no concept of a known-vulnerable version range,
  a deprecated package, or any risk signal beyond "is the version string
  exactly one of two literal values." It also has no live vulnerability
  database access of any kind (nothing in this codebase calls out to
  npm audit, OSV, or any CVE feed), which matters directly for what this
  spec is allowed to propose — see Safety Constraints.
- All three skills' output is a single text `result` string
  (`processTask()`, line 312) with no structured fields — dashboards and
  the TUI just render it as preformatted text.
- Confirmed: Security has **zero** MCP tool access today
  (`packages/agents/security/index.ts` imports only `fs`/`fs/promises`
  directly — no `mcp-client.ts` exists for this agent, unlike
  DevOps/Testing/Documentation) and **zero** write skills, confirmed by
  `grep`-reading the file for `NEEDS_APPROVAL`/`resumeTask`/`actionId`
  (none present).

## Proposed Behavior

### What the harness may do, and what it structurally cannot

The LLM's role is **strictly additive commentary on findings the
deterministic scan already produced** — it never runs its own scan,
never decides what counts as a finding, and never removes, downgrades,
or reorders a finding the deterministic code already surfaced. This is
enforced by the *shape* of what the model is allowed to return, not by
a prompt instruction alone: the Zod schema the model's output must
validate against has no field that could mean "delete finding N" or
"lower this finding's confidence" — only additive fields (see Scope
below). The deterministic findings list is always computed first,
always included in the task result in full, and is never filtered by
anything the harness returns.

### No new tool access — a deliberate, evidence-checked no

`042`'s DevOps harness earned a genuine new tool
(`read_project_file`) because three concrete parameter-guessing gaps
were traced directly to the agent not being able to see real file
content. Checking the same bar here: every one of this spec's three
proposed enhancements (see Scope) operates entirely on data the
deterministic scan **already computed** — the finding list itself
(`scan-secrets`), the covered/missing pattern lists plus the project's
own directory listing that `check-gitignore-coverage` could pass along
cheaply, and the parsed dependency map (`audit-dependencies`). None of
the three needs the model to go read arbitrary files or run further
commands to do its job. There is no evidence-backed case for adding
MCP access (or any new tool) to Security in this checkpoint, so none is
added — Security stays direct-`fs`, zero MCP tools, unchanged from
`specs/011`'s decision (c). If a future need is found (e.g., wanting
surrounding-line context for a specific `scan-secrets` hit), it gets
its own spec grounded in that concrete gap, same as `042`'s own
precedent.

This also means this harness does not need LangGraph's tool-calling
loop — the reason `026`/`041`/`042` used `StateGraph` was specifically
the multi-turn "call a tool, observe, decide again" cycle. With no tool
to call, a `StateGraph` here would be a single node with a self-loop
that never triggers a build-time `READ_ONLY_TOOL_NAMES` check because
there'd be nothing bound to it — machinery with no job. This harness
is instead a single structured-output completion (Zod-validated,
bounded retry-with-feedback on invalid shape, same `MAX_RETRIES`
precedent as the graph-based harnesses) built directly on the same
shared, inert-until-called `buildChatModel()`
(`packages/shared/llm-model-factory.ts`) the other three harnesses
already use. This is a real, load-bearing architectural difference from
`026`/`041`/`042`, not an oversight — it is called out explicitly here
for the same reason `042` called out its "parameters, not content"
scoping: so a future reader doesn't wonder why this one harness skips
LangGraph.

### Scope: what each skill's enrichment adds

- **`scan-secrets`**: given the full deterministic finding list (file,
  line, confidence, label, masked value — never the raw unmasked
  value), the model returns per-finding commentary
  (`{ findingIndex: number, likelyFalsePositive: boolean, note: string
  }[]`) flagging findings that look like test fixtures, documentation
  examples, or placeholder-shaped values the hardcoded
  `PLACEHOLDER_VALUES` set doesn't happen to cover — plus an optional
  `summary: string`. The raw finding list is rendered first, complete
  and byte-identical to pre-`043` output (deliberately no index printed
  into it, so the flag-unset guarantee below holds exactly); the
  commentary is rendered as a clearly separate, clearly labeled "AI
  Commentary" section, correlated back to each finding by its
  `file:line` (which the deterministic section already shows), never
  replacing or hiding the finding it comments on.
- **`check-gitignore-coverage`**: given the deterministic
  covered/missing pattern results plus a shallow (top-level plus one
  level deep, same `EXCLUDED_DIRS` exclusions already used elsewhere in
  this file) directory listing of the project, the model may propose
  **additional** patterns worth gitignoring that it can see genuine
  evidence for in that listing (`additionalSuggestions: { pattern:
  string, reason: string }[]`) — e.g., a real `terraform.tfstate` file
  present. It cannot mark a required pattern as covered when the
  deterministic check found it missing, and cannot suppress the
  `[CRITICAL]` `.env`-uncovered line — those are computed and rendered
  exactly as today, before any LLM section.
- **`audit-dependencies`**: given the deterministic unpinned-version
  findings plus the full parsed dependency map, the model may add
  general, non-specific risk commentary (`generalNotes: string[]`) —
  e.g., noting that an unpinned dependency can pull in unreviewed
  future changes, or that a package name looks like a plausible
  typosquat of a well-known package it recognizes. It is explicitly
  forbidden from asserting a specific CVE identifier, a specific
  vulnerable version range, or any other claim that implies live
  vulnerability-database knowledge it does not have — see Safety
  Constraints for how this is enforced, not just requested.

### Fail-open-on-report, fail-closed-on-claim: the actual safety rule

`026`/`028`/`041`/`042` all share one rule: once the harness flag is
active, a misconfiguration or run failure fails the *task* closed —
never a silent fallback to the deterministic path, because the
deterministic path there produces a plan, a piece of prose, or a set of
write parameters that would otherwise look indistinguishable from an
LLM-enhanced one. Applied literally here, that rule would mean: if the
commentary call fails, discard the deterministic scan results — which
are already complete, safe, and correct on their own — and fail the
whole task. That would make turning this flag on strictly worse than
leaving it off, for zero safety benefit; there is no wrong write being
prevented, because there is no write.

So this spec applies the same rule's actual **purpose** (a user must
never be left believing they got LLM enrichment when they silently
didn't) with a different mechanism suited to an additive-only,
read-only report:

- The deterministic scan **always** runs and its result is **always**
  the task's core content, unchanged from today, regardless of harness
  state, flag, or outcome.
- If `ORCHESTRAI_SECURITY_LLM_HARNESS=1` is set and the enrichment call
  fails (missing/invalid credentials, API error, exhausted
  retry-with-feedback, a CVE-claim rejection — see below) or the flag
  is set but `ORCHESTRAI_LLM_API_KEY` is missing, the report **still
  completes** and includes an explicit, visible line — `"AI commentary
  unavailable: <reason>"` — in the exact section the commentary would
  have occupied. It is never silently omitted and never rendered as if
  no commentary had been needed.
- The task itself never transitions to `failed` because of the
  enrichment layer alone; only a failure in the pre-existing
  deterministic scan itself (a missing path, an unparsable
  `package.json` — both already-existing `throw`s in
  `packages/agents/security/index.ts`) fails the task, exactly as it
  does today.

This is a deliberate, reasoned departure from `041`/`042`'s literal
shape, not an inconsistency — it is the same transparency goal, applied
honestly to a skill where the deterministic output was never at risk of
being silently swapped for something wrong.

### Grounding against CVE hallucination

`audit-dependencies`'s enrichment is the one place a model could
plausibly assert something false with real-sounding authority: a
specific CVE ID or version range it has no live database access to
confirm. This is checked structurally, the same way the read-only tool
allow-list is structurally enforced elsewhere in this codebase, not
left to a prompt instruction alone: the validator that checks the
model's structured output against its Zod schema additionally rejects
(triggering the same bounded retry-with-feedback the shape-validation
failure path already uses) any `generalNotes` entry matching
`/CVE-\d{4}-\d+/i` or an explicit version-range claim pattern
(`/\bv?\d+\.\d+\.\d+\s*(<|<=|>|>=)/`). Two rejected retries exhaust to
the same "AI commentary unavailable" line above, never a silently
stripped note.

### Flag and configuration

Follows `specs/039`'s established per-component pattern exactly:
`ORCHESTRAI_SECURITY_LLM_HARNESS=1` (new `LlmComponent` value
`"security"` added to `packages/shared/llm-model-factory.ts`, mirroring
the `"documentation"`/`"devops"` additions `041`/`042` already made),
resolved via `ORCHESTRAI_SECURITY_LLM_<FIELD>` before falling back to
the shared `ORCHESTRAI_LLM_<FIELD>` variables. With the flag unset (the
default), all three skills are byte-identical to today — confirmed live
against the compiled binary, same as `041`/`042`.

## Scope

In scope:

- `packages/agents/security/llm-harness.ts` (new): the three
  structured-output enrichment functions
  (`runScanSecretsEnrichment`, `runGitignoreEnrichment`,
  `runAuditDependenciesEnrichment`), their Zod output schemas, the
  CVE/version-claim rejection check, and bounded retry-with-feedback —
  no `StateGraph`, no tool binding (see Proposed Behavior).
- `packages/agents/security/model-factory.ts` (new): mirrors
  Documentation's/DevOps's file shape; owns
  `isHarnessFlagSet()`/`ORCHESTRAI_SECURITY_LLM_HARNESS`.
- `packages/shared/llm-model-factory.ts`: add `"security"` to
  `LlmComponent`.
- `packages/agents/security/index.ts`: each of the three skill
  functions gains an enrichment call gated on `isHarnessFlagSet()`,
  appended to the existing deterministic text output — the
  deterministic computation itself (`skillScanSecrets`,
  `skillCheckGitignoreCoverage`, `skillAuditDependencies`) is otherwise
  unmodified.
- `packages/agents/security/package.json`: add
  `@langchain/core`/`zod` (not `@langchain/langgraph` — no graph is
  used here; confirm at implementation time whether `@langchain/core`
  alone is sufficient for a structured-output call against
  `buildChatModel()`'s returned `BaseChatModel`).
- Tests: `llm-harness.test.ts`, `model-factory.test.ts`, one
  `llm-model-factory.test.ts` addition for `"security"` — same shape as
  `041`/`042`.
- `CLAUDE.md`, `README.md`, `context/worklog.md` updates.

Out of scope (see Out of Scope / Non-Goals for the full list):
converting Security to an MCP client, adding any new tool/file-access
surface to Security, live vulnerability-database integration (npm
audit, OSV, or any CVE feed), any change to Security's task/dashboard
API shape beyond the appended commentary text, any write capability for
Security.

## Safety and Compatibility Constraints

- With the flag unset, all three skills are byte-identical to current
  behavior — no new field, no new text, nothing observable changes.
  Live-verified against the compiled binary before this spec closes,
  matching `041`/`042`'s precedent.
- The deterministic scan is always computed first and is never
  altered, filtered, reordered, or suppressed by anything the LLM
  returns — enforced by the output schema's shape (additive-only
  fields), not by a prompt instruction alone.
- No raw, unmasked secret value is ever sent to the model — only the
  already-masked value (`maskSecret()`'s output), file path, line
  number, confidence, and label, mirroring what the deterministic
  report itself already shows a human.
- `audit-dependencies` enrichment must never assert a specific CVE
  identifier or version-range vulnerability claim — structurally
  rejected by the validator, not merely discouraged in the prompt; see
  Grounding against CVE hallucination.
- A harness failure (misconfiguration, API error, exhausted retries,
  a rejected CVE-shaped claim) never fails the overall task and never
  silently omits the fact that enrichment was attempted and didn't
  happen — see Fail-open-on-report, fail-closed-on-claim above.
- No new tool access, no MCP conversion, no write capability — Security
  stays exactly the read-only, direct-`fs`, no-approval-gate agent it
  is today, with one additive, clearly-labeled, always-optional
  commentary section layered on top.
- Same credential-handling discipline as every prior LLM-harness spec
  in this repository: never printed, never logged, redacted in any
  saved evidence file.

## Out of Scope / Non-Goals

- Converting Security to an MCP client (`specs/011` decision (c) stands
  unchanged).
- Any new tool or file-access surface for Security beyond what the
  deterministic scans already compute (no evidence-backed need found —
  see Proposed Behavior).
- Live vulnerability-database integration (npm audit / OSV / any CVE
  feed) — this spec deliberately keeps the model's dependency
  commentary non-specific precisely because no such integration exists
  to ground a specific claim in.
- Any write capability, approval gate, or `actionId` machinery for
  Security — it remains fully read-only.
- Expanding `PLACEHOLDER_VALUES` or `REQUIRED_GITIGNORE_PATTERNS`
  deterministically — the LLM commentary is the enhancement mechanism
  for exactly the gaps those fixed lists have; the fixed lists
  themselves are untouched.
- A LangGraph-based implementation — deliberately scoped out; see
  Proposed Behavior for why.

## Acceptance Criteria

- [x] `packages/shared/llm-model-factory.ts` accepts `"security"` as a
      valid `LlmComponent`; existing components unaffected.
- [x] `packages/agents/security/model-factory.ts` exists, mirrors
      Documentation's/DevOps's shape, flag is
      `ORCHESTRAI_SECURITY_LLM_HARNESS`.
- [x] `packages/agents/security/llm-harness.ts` exists with the three
      enrichment functions, Zod schemas, bounded retry-with-feedback,
      and the CVE/version-claim rejection check.
- [x] With the flag unset, all three skills produce byte-identical
      output to current behavior — verified via `bun test` and against
      the compiled binary.
- [x] With the flag set and valid credentials, each of the three
      skills' output includes a clearly labeled, separate commentary
      section, with the original deterministic findings unchanged and
      unfiltered above it.
- [x] A finding-shaped placeholder value not in `PLACEHOLDER_VALUES`
      (e.g. `"CHANGE_ME_IN_PRODUCTION"`) is correctly flagged as a
      likely false positive by the enrichment layer in a live run,
      while the raw finding itself still appears in the deterministic
      section exactly as before.
- [x] A real, evidence-backed gitignore gap (a sensitive file present
      in the project but not in `REQUIRED_GITIGNORE_PATTERNS`) is
      correctly suggested by the enrichment layer in a live run.
- [x] A forced CVE-shaped or version-range-shaped claim in a model
      response is rejected by the validator (unit test with a fake
      model response), triggering retry-with-feedback, never passed
      through.
- [x] A harness failure (no API key, invalid config) leaves the task
      `completed` with the deterministic findings intact and a visible
      "AI commentary unavailable" notice — never `failed`, never a
      silent omission.
- [x] `bun test`, `bun run typecheck`, `bun run specs:catalog`, `bun run
      specs:check` all pass.
- [x] Binary size delta measured (before/after `bun run build`), not
      assumed.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated.

## Verification Plan

Mirrors `041`/`042`: `bun test` for the new unit suites (retry-with-
feedback, CVE-claim rejection, flag-unset byte-identical behavior via
fake/mocked model responses — no live credentials required for this
tier); `bun run typecheck`; a live pass against the real Gemini
credentials already configured in
`C:\Users\moham\test-target-project\.orchestrai\config.env`, using a
disposable scratch project deliberately constructed to exercise all
three gaps identified in Verified Current State (a placeholder-shaped
secret not in the hardcoded list, a sensitive file not in the
hardcoded gitignore pattern list, an unpinned dependency with a
plausible-sounding but unverifiable name); confirm the flag-unset
regression against the same scratch project and the real compiled
binary; confirm cleanup (no orphaned processes, no credential leakage
in any saved evidence file) after every live pass, same discipline as
every prior checkpoint this session.

## Verification Results (2026-09-02)

**Automated:** `bun test` — 480 passed, 0 failed (up from 454 pre-`043`:
+25 in `packages/agents/security/{llm-harness,model-factory}.test.ts`,
+1 in `packages/shared/llm-model-factory.test.ts` for `"security"`).
`bun run typecheck` — 0 errors. `bun run specs:catalog` +
`bun run specs:check` — clean for 43 specs.

**A real bug found and fixed during this checkpoint's own live
verification, not assumed away:** the first implementation pass added
an `[idx]` index prefix to each `scan-secrets` finding line so the
opt-in commentary section could correlate back to it — but that prefix
was printed unconditionally, breaking the flag-unset byte-identical
guarantee this spec itself requires (Acceptance Criteria). Caught by
actually diffing a flag-off live run against the pre-`043` format,
not by inspection. Fixed by reverting the deterministic section to its
exact original formatting and correlating commentary by `file:line`
(already present in that unchanged section) instead of by index —
confirmed with a second live pass afterward. This is the same kind of
finding `specs/018`/`030`/`028` each record: real verification catching
something code review alone did not.

**Binary size delta:** measured via `wc -c`, not estimated —
147,758,080 → 147,771,904 bytes, **+13,824 bytes**, zero new
dependency (`@langchain/core`/`zod` were already bundled by `041`/`042`;
this spec deliberately adds no `@langchain/langgraph` — see "No new
tool access" above for why no graph is used at all). Smaller than
`042`'s own +14,336 byte delta, consistent with skipping LangGraph
entirely.

**Live, real machine, real Gemini key** (`gemini-3.5-flash-lite`,
`test-target-project/.orchestrai/config.env`), against the real
compiled binary, never this repository — a disposable scratch project
was deliberately constructed to exercise all three gaps identified in
Verified Current State:

- `src/config.ts` containing `password: "CHANGE_ME_IN_PRODUCTION"` — a
  placeholder-shaped value not in the hardcoded `PLACEHOLDER_VALUES`
  set, so the deterministic scan correctly still flagged it (unchanged
  behavior). The AI Commentary section correctly identified it as a
  likely false positive ("The masked value 'CHAN...TION' strongly
  indicates a placeholder such as 'CHANGE_ME_IN_PRODUCTION' rather than
  a real credential") while the raw `[MEDIUM CONFIDENCE]
  src\config.ts:3` finding remained fully visible and unedited above
  it — the additive-only guarantee holding under a real model, not
  just the unit tests' mocked one.
- A real `terraform.tfstate` file present at the project root, not
  covered by `.gitignore` and not in `REQUIRED_GITIGNORE_PATTERNS`
  either — invisible to the deterministic check entirely. The AI
  Commentary section correctly suggested it ("A real terraform.tfstate
  file is present in the directory listing, which contains sensitive
  infrastructure state data"), grounded in the real shallow directory
  listing it was given, not invented.
- `package.json` with `"left-pad": "*"` — the deterministic check
  correctly flagged it as unpinned (unchanged). The AI Commentary
  section added two general, non-specific notes (unpinned-version risk,
  and a typosquatting-naming observation) with **no CVE identifier and
  no version-range claim** — the forbidden-claim guard's live behavior
  matched its unit-test coverage; it simply never had to trigger
  because the model's own real output already stayed within bounds.
- **Flag-unset regression**, same scratch project, same compiled
  binary: all three skills' output confirmed byte-identical to the
  pre-`043` format shown in Verified Current State — no `AI Commentary`
  section, no formatting change of any kind. Directly contrasted
  against the flag-on run above from the same project.
- **Fail-open-on-report confirmed**: flag set, `ORCHESTRAI_LLM_API_KEY`
  unset — the task still reached `completed` with the deterministic
  `[MEDIUM CONFIDENCE] src\config.ts:3` finding fully intact, plus an
  explicit `AI commentary unavailable: ORCHESTRAI_SECURITY_LLM_HARNESS=1
  is set but ORCHESTRAI_LLM_API_KEY is missing` line — never `failed`,
  never a silent omission. This is the live proof of this spec's central
  departure from `041`/`042`'s "fail the whole task" precedent.
- Cleanup confirmed after every pass: `taskkill` + `tasklist`/`netstat`
  showed zero orphaned `orchestrai.exe` processes and no service ports
  listening; every saved log grepped clean
  (`grep -lE "AQ\.|AIza|api_key=[A-Za-z0-9]"`, exit code 1) before
  deletion; scratch project files removed from
  `test-target-project` after the pass, leaving only its `.orchestrai/`
  config directory as before.

**Not exercised live** (covered instead by the unit suite, matching the
Acceptance Criteria's own scoping): a model response actually
asserting a CVE identifier or version-range claim, and a validator
rejection round-trip — `runAuditDependenciesEnrichment`'s tests cover
both a forced CVE-shaped claim being rejected-then-retried into a
compliant response, and every retry persistently offending exhausting
to `null`. Deliberately not forced live: coaxing a real model into
violating an explicit system-prompt instruction on demand is
unreliable and not the same kind of evidence as a live-observed real
gap being closed.

## Approval Requested

Pre-approved 2026-09-02 per Yusuf's explicit instruction to proceed
autonomously through `042` and `043`, including authority to add tools
where implementation reveals genuine evidence of need. This checkpoint
found no such evidence for Security (see "No new tool access" above),
so none is added. Proceeding directly to implementation.
