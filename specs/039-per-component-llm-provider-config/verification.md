## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/039-per-component-llm-provider-config/spec.md` (implemented,
**verified**). Before this checkpoint, the two LLM-capable components —
Planning's harness above and the Orchestrator's supervisor — read the
exact same three variables (`ORCHESTRAI_LLM_PROVIDER`/`_MODEL`/`_API_KEY`)
with no way to differ, and `apps/supervisor/index.ts`'s `spawnService()`
hands every spawned child the identical full environment, so there was no
supported way to give them different models through `bun run orchestrai`,
the compiled binary, or the wizard.

`packages/shared/llm-model-factory.ts`'s `readLlmModelConfig()` now takes
an optional component identifier (originally `"planning"` | `"orchestrator"`
— a closed set defined in code, never derived from input; current set is
`LLM_COMPONENTS` — `"orchestrator"`, `"documentation"`, `"devops"`,
`"security"`, `"conversation"` — since `specs/041`–`044` each added their
own component and `specs/051` removed `"planning"` along with Planning
Agent itself) and resolves each of the three fields independently:
`ORCHESTRAI_<COMPONENT>_LLM_<FIELD>` wins when set and non-empty,
otherwise the existing shared `ORCHESTRAI_LLM_<FIELD>` is used — per
field, so sharing a key while overriding only the model is the expected
common case. Called with no component argument (every pre-039 call site,
and any future caller that doesn't need this), it is **byte-identical to
before this spec** — live-verified, not just asserted in tests: a config
hand-crafted in the exact pre-039 shape (`ORCHESTRAI_ORCHESTRATOR_GRAPH`
absent entirely, not merely `0`) still routed `plan-task` to Planning,
unchanged, at the time this was written — see "Planning Agent (retired)"
above for what replaced that path. No change to `spawnService()` was
needed — since every child already inherits the full
environment, each component reading only its own namespace first is
sufficient. A component whose own namespace is misconfigured fails on its
own path and never silently resolves a sibling's credentials — structural,
asserted adversarially. Startup summaries now name the resolved provider,
model, and **which variable each came from** (`describeLlmModelConfig()`)
so two components on different models are distinguishable in the logs —
never the credential value itself, live-confirmed by grepping real
startup logs against a real key.

This also closed a real, unrelated gap found while grounding the spec:
`apps/supervisor/init-wizard.ts` could not enable the adaptive supervisor
at all — it predates `specs/028` and only ever asked about "the LLM
planning harness." The wizard now asks a second, independent yes/no
("Enable the adaptive supervisor for plan-task?"), reusing the same
provider/model/key answers for both rather than prompting twice, and
writes `ORCHESTRAI_ORCHESTRATOR_GRAPH` accordingly. Live-verified end to
end with a real Gemini key: a non-TTY wizard round-trip wrote the flag
correctly; a zero-flag startup from that config genuinely routed a
`plan-task` request to `orchestrator-supervisor` (not Planning); setting
`ORCHESTRAI_ORCHESTRATOR_LLM_MODEL` differently from Planning's shared
default produced two different real Gemini API calls naming each
component's own resolved model (the deliberately-wrong first attempt's
error — `"models/gemini-3.5-pro is not found ... for generateContent"` —
was itself proof the override reached the real API call); and a
same-environment retry with a known-working override model produced a
genuine two-step adaptive dispatch (`analyze-project` then `dockerize`,
the second decided only after observing the first's real result) that
correctly reached a real `actionId`-bound approval gate, deliberately
rejected to avoid an unneeded write. See
`specs/039-per-component-llm-provider-config/spec.md`'s Verification
Results for the full record, including one real, disclosed mistake made
during this pass (an `rm -rf` accidentally deleted an unrelated scratch
directory holding real credentials from `specs/028`'s earlier testing;
nothing from it had ever been committed, and Yusuf re-supplied the
credential directly).

Explicitly out of scope for this checkpoint: adding LLM capability to any
agent that doesn't have it today (DevOps, Testing, Documentation,
Security — a separate, later proposal, each needing its own approval);
per-component rate limits, budgets, or cost accounting; any change to
`buildChatModel()`, the provider list, or model defaults; and a config
file format beyond environment variables.

See specs/054-capability-driven-llm-routing/verification.md for the relocated narrative covering this checkpoint.

See specs/064-supervisor-startup-key-check-non-blocking/verification.md for the relocated narrative covering this checkpoint.

See specs/041-llm-harness-documentation/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
