# Verification — specs/083-coder-agent

Recorded 2026-09-14, same session as implementation.

## Unit / HTTP-level

- **`packages/agents/coder/llm-harness.test.ts`** — 15 tests, a
  `ScriptedChatModel`/`MockMcpToolCaller` pairing (the same technique
  `packages/agents/code-review/llm-harness.test.ts` already
  established), no live model or MCP server: a uniquely-grounded
  proposal returned as-is; a pure deletion (`new_text: ""`) as a valid
  response; the model calling `read_project_file` for real related-file
  context before responding; a not-found `old_text` triggering exactly
  one retry that then succeeds; an ambiguous `old_text` (matches more
  than once) triggering a distinct retry message that then succeeds; a
  persistently not-found `old_text`, after exhausted retries, failing
  closed (`null`) — no partial edit to salvage, unlike `082`'s own
  multi-comment case; a persistently ambiguous `old_text` likewise
  failing closed; structurally invalid JSON triggering retry-with-
  feedback and recovering; exhausted retries on persistent invalid JSON
  failing closed; an empty `old_text` correctly treated as a schema
  failure, not a grounding failure. `countOccurrences()` gets its own
  focused unit tests (0/1/repeated/empty-needle). Constructed a fresh
  `AIMessage` per scripted attempt throughout — the exact
  `082`-documented LangGraph message-identity pitfall was deliberately
  avoided from the start here, not rediscovered.
- **`packages/agents/coder/index.test.ts`** — 11 tests, real HTTP
  requests against the real, unmodified app: Agent Card advertises
  exactly `edit-file`; the approve/reject routes genuinely exist (a real
  JSON `{error:"Task not found"}` 404, distinct from Hono's own
  unmatched-route 404) — unlike `082`'s read-only agent, this is a
  write-capable skill and needs them; skill detection for both trigger
  phrasings, for a trigger word with no file extension (correctly
  falling through to "unknown", not a false match), and for unrelated
  text; the full four-deep fail-closed precondition chain (no file →
  no description → no resolvable project root → harness off), each
  checked to fail with a *distinct* named error, confirming the checks
  run in the intended order and don't mask each other.

## Registration-point wiring

Every registration point named in `plan.md` was applied:
`service-ports.ts`, `agent-registry.ts`, `apps/orchestrator/index.ts`'s
`KNOWN_AGENTS`, `apps/supervisor/index.ts`'s `SERVICE_STARTERS`/
`AGENTS`, `apps/supervisor/agent-catalog.ts` (+ its drift test),
`apps/orchestrator/supervisor-graph.ts`'s `SKILL_TIER_REGISTRY`/
`SUPERVISOR_ALLOWED_SKILLS`, root `package.json`'s script +
`--parallel` strings, `docker-compose.yml`,
`packages/shared/llm-model-factory.ts`'s `LLM_COMPONENTS`,
`apps/supervisor/init-wizard.ts`'s `AGENT_LLM_HARNESSES`, and
`apps/supervisor/init-form.tsx`'s `PORT_ROW_LABELS`.

**No additional gap was found this time** — `bun run typecheck` passed
clean on the first attempt after wiring every point from `plan.md`'s own
list. `082`'s own missed 7th touchpoint (`PORT_ROW_LABELS`) was applied
from the start here since `plan.md` named it explicitly in advance,
learning directly from that prior finding rather than rediscovering it.

Six pre-existing tests in `apps/supervisor/init-form-state.test.ts`
needed updating for the 6th agent joining shared tables (the local
`AGENTS` fixture array, `modelsRows()`/`agentLlmFieldsFor()`/
`formStateToWizardConfig()` expectations) — the same class of update
`specs/082`'s own addition required; all six are legitimate behavior
changes, not test-only patches.

`bun test`: 1009 pass, 0 fail (up from the pre-083 baseline of 982 —
net +26 accounts for the 15 harness tests, 11 HTTP tests, and the 6
updated pre-existing tests, less one test removed net across files);
`bun run typecheck`: 0 errors; `bun run specs:catalog`/`specs:check`:
passed for 82 specs.

## Live pass, 2026-09-14 (real Gemini deployment, real key)

Same real key/provider/model as `specs/080`/`081`/`082`'s own live
passes (`.orchestrai/config.env`, never echoed or logged). Stack: real
`mcp:http` (3006), real `coder-agent` (3008,
`ORCHESTRAI_CODER_LLM_HARNESS=1`), and — for the router-naming scenario
— the real `orchestrator` (3000), with `coder-agent` the *only* agent
online (no other agent process started), isolating the routing decision
the same way `082`'s own live pass did.

**Fixture**: a real git repository with a genuine baseline commit
(`math.ts` with `clamp()`/`average()`), no planted bug this time — three
real, sequential improvement requests dispatched against it.

**Scenario 1 — a real anchored edit, proposed, previewed, approved, and
landed.** `POST /tasks {"text": "edit math.ts: make average return 0
for an empty array instead of NaN, at <scratch>"}` (no `selectedSkill`)
resolved to `assignedAgent: "coder-agent"`, `skill: "edit-file"`, and
reached `input-required` with a real approval preview. The proposed
edit touched **only** the `average()` function — `clamp()`
was byte-identical between the preview's `previousContent` and
`content`, confirming the model correctly scoped the anchor rather than
regenerating the whole file:

```diff
 export function average(numbers: number[]): number {
+  if (numbers.length === 0) return 0
   return numbers.reduce((a, b) => a + b, 0) / numbers.length
 }
```

Approved: the real file on disk afterward matched the preview's
`content` exactly, confirmed by reading the file directly, not just
trusting the task result text.

**Scenario 2 — drift-refusal.** A second real edit (`rename average
into computeAverage`) reached a real preview. The file was then
manually mutated on disk (`echo "// manually mutated..." >>
math.ts`) before approving. Approving the now-stale `actionId` was
refused with the exact designed error: `"Target \"math.ts\" changed
after approval but before this write — refusing to overwrite unreviewed
content. Resubmit for a fresh preview."` The file afterward still held
the manual mutation, byte-for-byte — confirmed by re-reading it, not
corrupted or partially written.

**Scenario 3 — rejection creates nothing.** A third real edit (`add a
doc comment above clamp`) reached a real preview. The file's md5 hash
was recorded, the task rejected, and the hash re-checked — identical.

**Scenario 4 — router naming, zero hardcoded routing change.** With
`coder-agent` the only agent online (confirmed via `GET /agents`
returning exactly one entry), a natural-language `POST /tasks` with no
`selectedSkill` resolved to `{"assignedAgent":"coder-agent","skill":
"edit-file"}` purely from the live capability snapshot — Scenario 1's
own dispatch already demonstrated this directly, not a separate call.

All scratch artifacts (the temp git repo, task JSON files) and all
three background processes (`mcp:http`, `coder-agent`, `orchestrator`)
were removed/stopped after the pass; `git status` in the main repo
stayed clean throughout (the scratch repo was entirely outside it,
under the OS temp directory).

## What remains open (why `verification: partial`)

- **The not-found/ambiguous-anchor retry-with-feedback scenarios still
  were not organically observed against the real live model — three
  further deliberate attempts, 2026-09-15, all still didn't trigger
  one.** A scratch file with three genuinely identical
  `console.log("processing");` lines (one per function) was
  constructed specifically to bait a naive, too-short `old_text`
  anchor. Three separate real requests were dispatched against it: (1)
  a vague "change the log message to say done instead of processing"
  with no disambiguation — the model correctly widened its anchor to
  the **entire file's content** (which, as a whole, occurs exactly
  once), changing all three call sites in one grounded, non-ambiguous
  edit; (2) the identical vague request repeated — identical result;
  (3) an explicit "in step2 only, leave step1 and step3 exactly as
  they are," with the instruction's own quoting deliberately using
  single quotes (`console.log('processing')`) against the file's real
  double-quoted source — the model correctly identified the real,
  double-quoted text, anchored on `step2`'s specific surrounding
  function context, and produced a precise edit touching only that one
  call site, `step1`/`step3` byte-identical in the diff. All three
  proposals were correct, well-grounded, and required no retry. This
  is a genuine, real finding about this model's behavior on ambiguous
  input — it prefers **widening the anchor** (using more surrounding,
  uniquely-identifying context, up to the whole file) over quoting an
  ambiguous short span — not a gap in this session's own testing
  effort. The mechanism itself remains hermetically proven
  (`llm-harness.test.ts`'s 4 dedicated tests: a genuine not-found and a
  genuine ambiguous-anchor case, both scripted, both correctly trigger
  retry-with-feedback); forcing a live organic retry would need either
  a more adversarial prompt (a truly indistinguishable target with no
  possible wider unique anchor) or a smaller/cheaper model more prone
  to a naive first guess — recorded honestly as still open rather than
  assumed proven, and now backed by three real, not zero, live
  attempts.
- ~~A `docker compose up` pass exercising the new `coder-agent` service
  block.~~ **Closed 2026-09-14 (same day the disk/Docker crisis from
  `specs/082`'s own record was resolved)**: a real `docker compose up`
  brought up all 8 containers including `coder-agent`; its own
  `/healthz` confirmed `ready: true` and `mcp.state: "connected"`
  against the real `mcp-http` container (see `specs/082`'s
  `verification.md`, "Docker Desktop live pass, 2026-09-14 (same day,
  later)" section, for the full transcript — that pass exercised the
  whole compose stack, `coder-agent` included, not `code-review-agent`
  alone). `edit-file` itself was not re-dispatched in that pass (no
  live provider key available there) — its own real-model live pass
  above already covers that end to end against a non-Docker stack; this
  closes only the "does `coder-agent` come up correctly inside compose"
  half of the gap, which is what was actually missing.

Every other property named in this spec's own Acceptance Criteria,
including all four fail-closed preconditions, the drift-refusal, the
rejection-creates-nothing case, and the router-naming confirmation, is
verified live above.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

Phase E (a write-capable Coder Agent) was originally gated on **both**
this phase and `specs/081` reaching `verification: verified` — at the
time neither had (this phase's own then-open Docker-compose gap above;
`079`'s separate, unrelated third-party-MCP-server gap). Yusuf's own
explicit call, 2026-09-14: proceed on the strength of the proven
*mechanism* (both phases' own live-provider passes already prove what
Phase E's gate exists to protect) rather than continue blocking
indefinitely on Docker Desktop's local availability — see Phase E's own
section below for what that decision led to. `specs/083` itself stays
`verification: partial` for its own, separate, still-open reason (the
not-found/ambiguous-anchor retry scenario never forced against a real
model) — not the Docker gap, which its own `coder-agent` service block
is now confirmed to clear too (see `specs/083`'s own `verification.md`).

`specs/083-coder-agent/spec.md` (implemented, **partial** verification,
2026-09-14) is Phase E — the roadmap's own **risk class 5**: writing
model-authored *source code*, the first phase where a model's own
output can change program behavior, not just documentation content
(`041`), tool parameters (`042`), or a test file (`081`). A 6th agent,
**`coder-agent`, port 3008**. One skill, **`edit-file`**: proposes a
precise, anchored edit to one real file — an exact, uniquely-occurring
span (`old_text`) replaced with new content (`new_text`) — shown as a
content diff and requiring human approval before anything is written.

**Explicitly v1, stated plainly in the spec itself, not left implicit**:
single-file, single-hunk, no new-file creation, no auto-chained review,
external target projects only (never OrchestrAI's own source tree).
Every one of these was a deliberate "ship the smallest safe slice
first" choice — the same pattern `082` used (diff-hunks-only, then
widened after direct feedback) and `081` used (one file per approval) —
and the spec's own "Future Upgrade Path" section names exactly what
each one would take to lift, so a later engineer or agent doesn't have
to rediscover the tradeoff from scratch.

**The key design finding, made before any code was written**: re-
reading `ApprovalPreview` and `write_project_file` closely showed the
"materially larger approval card" concern `078`'s own `plan.md` had
flagged for this phase doesn't actually apply once edits are scoped to
one file at a time. A single-file anchored edit still ultimately
produces one ordinary before/after content pair — exactly the
`content`/`previousContent` shape `specs/040`/`056` already gave every
write skill, rendered by the same dependency-free diff every client
already knows how to show. Consequence: **no new MCP tool was needed
either** — `read_project_file`/`write_project_file` are both reused
completely unmodified, matching `042`'s own "increase tool surface only
where a real need is shown" principle. The "anchored" constraint is
purely an agent-side precision mechanism for how the model expresses
its own proposed change (reducing the chance of an LLM garbling
unrelated parts of a large file the way a naive whole-file rewrite
could), never a new approval-preview shape.

**The grounding validator is the real safety mechanism**, the same
structural-enforcement style `043`'s CVE guard and `082`'s diff
grounding already use: the proposed `old_text` must be an exact,
contiguous substring of the file's real, current content, occurring
**exactly once** — zero occurrences ("not found — quote it exactly")
or two-or-more ("ambiguous — give a longer, more specific span") both
trigger the same bounded retry-with-feedback shape every harness in
this codebase already uses; exhausted retries fail the task closed with
no partial edit to salvage (unlike `082`'s own multi-comment case,
which can drop just the bad one — a single edit proposal has nothing
to salvage from). Fail-closed, not fail-open, matching `081`/`082`:
there is no deterministic fallback for "make this specific code
change."

**Registration mechanics fully mirrored `082`'s own precedent**, with
one deliberate improvement: `082`'s own missed 7th touchpoint
(`apps/supervisor/init-form.tsx`'s `PORT_ROW_LABELS`, found only by
`tsc`'s exhaustiveness check) was named explicitly in this spec's own
`plan.md` in advance, so it was applied from the start rather than
rediscovered — `bun run typecheck` passed clean on the first attempt
after wiring every listed point, with no additional gap surfacing this
time.

1009 tests pass (0 fail; net +26 over `082`'s own 982 — six
pre-existing tests in `init-form-state.test.ts` needed updating for the
6th agent joining shared tables, all legitimate behavior changes, not
test-only patches), typecheck clean, `specs:check` passed for 82 specs.

**Live-verified against a real Gemini deployment**, a real scratch git
repository, three real sequential requests: **(1)** a real anchored
edit (`average()` gains an empty-array guard) correctly proposed,
touching only that function — `clamp()` byte-identical in the preview —
approved, and confirmed landed on disk exactly matching the preview.
**(2)** A drift-refusal: a second real preview shown, the file manually
mutated before approving, the stale approval refused with the exact
designed error, the file left holding the manual mutation, not
corrupted. **(3)** A rejection-creates-nothing case: a third real
preview's target file hash recorded, rejected, hash re-confirmed
identical. **(4)** The router-naming exit gate: with `coder-agent` the
only agent online, a natural-language request with no `selectedSkill`
resolved to `edit-file` purely from the live capability snapshot — the
same scenario `082` already proved for `review-diff`.

**Not yet live-verified**: the not-found/ambiguous-anchor
retry-with-feedback scenarios against the real model — hermetically
proven (4 dedicated harness tests). **Three further deliberate live
attempts, 2026-09-15**, using a scratch file with three genuinely
identical lines specifically to bait an ambiguous short anchor, still
didn't trigger one: the real model consistently preferred **widening
its anchor** (up to the entire file's own content, still a valid
exactly-once match) over quoting an ambiguous short span, correctly
grounding every proposal on the first attempt — a real, recorded
finding about this model's behavior on ambiguous input, not a gap in
testing effort. Forcing a live organic retry remains open, needing
either a target with no possible wider unique anchor or a smaller/
cheaper, more mistake-prone model. See `specs/083`'s own
`verification.md` for the complete transcript.

- ~~No Coder/Software Development Agent or Code Review Agent exists.~~
  Both now exist — see `specs/082-code-review-agent/spec.md` (read-only)
  and `specs/083-coder-agent/spec.md` (write-capable, v1: single-file,
  single-hunk anchored edits only — see that spec's own "Future Upgrade
  Path" for what a v2 would need).

See specs/109-document-api-drift-recheck/verification.md for the relocated narrative covering this checkpoint.

See specs/114-coder-multi-file-edit-and-create/verification.md for the relocated narrative covering this checkpoint.

See specs/089-plan-step-skip-continue/verification.md for the relocated narrative covering this checkpoint.
