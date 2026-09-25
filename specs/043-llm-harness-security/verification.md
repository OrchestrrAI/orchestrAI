## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/043-llm-harness-security/spec.md` (implemented, **verified**) —
the third of the per-agent LLM roadmap, and architecturally the most
different: Security has **no write skills and no approval gate at
all** (confirmed by reading `packages/agents/security/index.ts` end to
end — no `NEEDS_APPROVAL`, no `actionId`, nothing to gate), and stays
deliberately direct-`fs`, not an MCP client (`specs/011`'s decision
(c), untouched). So the risk this checkpoint manages isn't "a wrong
write happens" — there is no write — it's "the report lies to the
person reading it." The LLM's role is **strictly additive commentary
on findings the deterministic scan already produced**: it never runs
its own scan, never decides what counts as a finding, and never
removes, downgrades, or reorders one — enforced by the *shape* of the
Zod schema the model's output must validate against (no field that
could mean "delete finding N"), not by a prompt instruction alone. Set
`ORCHESTRAI_SECURITY_LLM_HARNESS=1` (one flag gating all three
read-only skills' commentary layer) alongside the shared LLM variables
every other harness uses.

**No new tool access — a deliberate, evidence-checked no.** Unlike
`042`'s genuine `read_project_file` addition, every one of this
checkpoint's three enhancements operates entirely on data the
deterministic scan **already computed** (the finding list itself, the
covered/missing gitignore patterns plus a cheap shallow directory
listing, the parsed dependency map) — no evidence-backed case for new
tool/MCP access was found, so none was added; Security remains zero
MCP tools, zero write capability. This also means the harness is
**deliberately not a LangGraph `StateGraph`**, unlike `026`/`041`/`042`:
those used LangGraph specifically for the multi-turn "call a tool,
observe, decide again" loop, and with no tool to call here that
machinery would have no job. This is a single structured-output
completion per skill with a plain bounded retry-with-feedback loop
implemented directly, built on the same shared, inert-until-called
`buildChatModel()`.

Grounded in real, evidence-confirmed gaps read directly from
`packages/agents/security/index.ts`: `scan-secrets`'s
`PLACEHOLDER_VALUES` is a seven-value hardcoded set — any other
placeholder-shaped value (`"CHANGE_ME_IN_PRODUCTION"`,
`"REPLACE_WITH_YOUR_KEY"`) is reported identically to a real leaked
credential, and the scanner has zero awareness of *where* a match sits
(a test-fixture file vs. real source). `check-gitignore-coverage`
checks a fixed, universal seven-pattern list with no awareness of what
the specific project actually contains — a real `terraform.tfstate` or
`.aws/credentials` file gets no signal at all. `audit-dependencies`
only flags a version string that is exactly `"*"` or `"latest"`, with
no live vulnerability-database access of any kind anywhere in this
codebase — which directly shaped a hard safety constraint (next
paragraph).

**Grounding against CVE hallucination**: `audit-dependencies`'s
enrichment is the one place a model could assert something false with
real-sounding authority. Checked structurally, the same enforcement
style `READ_ONLY_TOOL_NAMES` uses elsewhere: the validator rejects
(triggering the same bounded retry-with-feedback the shape-validation
path already uses) any note matching a CVE-identifier pattern or an
explicit version-range comparison — confirmed by unit test (a forced
CVE-shaped claim rejected and retried into a compliant response, and
persistent offending exhausting to `null`), and confirmed live the
model's own real output never needed the guard to trigger at all.

**Fail-open-on-report, fail-closed-on-claim — a deliberate departure
from `041`/`042`'s "fail the whole task" precedent, live-proven, not
just asserted:** the deterministic scan always runs and is always the
task's core content, unchanged from before this checkpoint, regardless
of harness state. A harness failure (missing key, invalid config,
exhausted retries) never fails the task — it appends an explicit,
visible `"AI commentary unavailable: <reason>"` line in place of the
enrichment section instead. Applying `041`/`042`'s literal "discard
everything and fail closed" shape here would have discarded findings
that are already complete and safe on their own, for zero safety
benefit — there's no wrong write being prevented, because there is no
write. Live-confirmed: flag set, no `ORCHESTRAI_LLM_API_KEY` — the task
still reached `completed` with the real deterministic finding fully
intact, plus the explicit unavailable notice, never `failed`.

**Live-verified against a real Gemini deployment**, a deliberately
constructed scratch project exercising all three gaps above: a
placeholder-shaped secret (`"CHANGE_ME_IN_PRODUCTION"`) not in the
hardcoded list — correctly flagged as a likely false positive by the
AI Commentary section while the raw finding stayed fully visible and
unedited above it; a real `terraform.tfstate` file invisible to the
fixed pattern list — correctly suggested, grounded in the real
directory listing given to the model; an unpinned `left-pad` dependency
— correctly given general risk commentary with **no CVE or version
claim**, never forced but never needed either. The flag-unset
regression was directly confirmed byte-identical against the same
project and the real compiled binary. **One real bug found and fixed
during this checkpoint's own live verification, not assumed away**: the
first implementation pass printed an `[idx]` index into the
deterministic `scan-secrets` finding lines so commentary could
correlate back to them — unconditionally, which broke the flag-unset
byte-identical guarantee. Caught by actually diffing a flag-off live
run, not by inspection; fixed by reverting that section to its exact
original format and correlating by `file:line` instead. Binary size
delta: **+13,824 bytes**, zero new dependency (smaller than `042`'s
own delta, consistent with skipping LangGraph entirely).

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.

See specs/082-code-review-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/084-security-external-vulnerability-data/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
