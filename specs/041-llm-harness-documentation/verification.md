## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/041-llm-harness-documentation/spec.md` (implemented, **verified**)
— the first of the proposed per-agent LLM roadmap, on the lowest-stakes
target: a mediocre generated doc rarely breaks anything, worst case it's
reviewed and rejected, same as today. Set
`ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1` (one flag for the whole agent,
gating both write skills together) plus the same shared
`ORCHESTRAI_LLM_API_KEY`/`_PROVIDER`/`_MODEL` variables (or their
`ORCHESTRAI_DOCUMENTATION_LLM_*` per-component overrides, `specs/039`)
every other harness uses.

Structurally mirrors Planning's own harness (`specs/026`) — one LangGraph
tool-calling loop, one read-only tool (`read_project_file`, the only tool
either skill needs; `project_root` is fixed in closure, never a model-
suppliable parameter — only the adaptive `relative_path` is exposed),
`READ_ONLY_TOOL_NAMES` structurally enforced the identical way
`buildReadOnlyTools()` already does. `write_project_file` is never bound.
No capability-catalog dependency (`specs/030`) — unlike Planning's output,
neither skill's output names another agent's skill, so there's nothing
for it to reference.

**One shared graph core, two entry points**, since `generate-readme` and
`document-api` need genuinely different designs once you actually read
what each deterministic path does today: `computeReadmeContent()` has
nothing reliable to ground on, so `runReadmeHarness()` explores freely
from the project root. `scanApiRoutes()` already finds real routes
reliably via a narrow regex — no hallucination risk — but writes weak,
mechanical descriptions (a single preceding comment or literally
`"No description provided."`); so `runApiDocHarness()` is *given* that
already-discovered route list as context and asked to write better
documentation for those specific routes, never to rediscover routes
itself. Route **discovery** stays fully deterministic either way —
`scanApiRoutes()` is unchanged — and a **grounding check** in validation
(a simple substring presence check per route, not semantic understanding)
confirms the response actually covers every discovered route, reprompting
with feedback if one's missing.


**The existing-README property — found as a real gap during drafting,
not assumed away.** The pre-`041` deterministic path had zero awareness
of an existing README when generating a new one; the prior content was
only ever fetched *afterward*, purely for `specs/040`'s diff. Fixed by
reusing that exact same already-fetched `previousContent` value as
harness context (no extra tool call) with an explicit instruction to
preserve or build on what's still accurate rather than rewrite blindly —
**live-proven with a planted marker sentence that survived byte-for-byte
into the generated output**, the single strongest piece of evidence in
this checkpoint.

**Fail-closed, never a graceful fallback, once the flag is active** —
the same precedent `specs/026`/`028` already established, deliberately
not relaxed just because Documentation happens to have a good
deterministic fallback for both skills. A misconfigured key or a run
failure (API error, exhausted retries, ungrounded output) fails the task
closed with a named error; an operator who opted in and misconfigured it
finds out immediately rather than unknowingly continuing to receive
mechanical output while believing the LLM path is active — live-confirmed:
a no-key run failed immediately with the exact named error, no file ever
written.

Live-verified against a real scratch project with a real Gemini
deployment: `generate-readme` made 5 genuine `read_project_file` calls
before producing content that correctly identified a Hono-based API and
documented both real endpoints, materially better than the deterministic
template; `document-api` covered both real routes with genuine HTTP
status codes/content types/response shapes, not just route names echoed
back; both approved writes matched their previews exactly (byte
comparison); and the flag-unset case was re-confirmed against the real
compiled binary (`dist/bin/orchestrai.exe`, freshly rebuilt), producing
the exact old mechanical template. Binary size delta: **+28,160 bytes**
(~27.5 KB), zero new dependency — `@langchain/*`/`zod` were already
bundled for Planning's own harness; this is purely new code.

See specs/039-per-component-llm-provider-config/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
