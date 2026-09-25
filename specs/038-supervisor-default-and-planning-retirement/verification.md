## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**`038` Phase 1's own live verification, 2026-09-02**, real machine, real
Gemini key, the real compiled binary, a reduced 4-process stack: three
scenarios directly contrasted against each other on the identical request
("build and deploy my bun app") — **(a)** flag genuinely unset, real key
present → `assignedAgent: "orchestrator-supervisor"`, a genuine two-step
adaptive dispatch, Planning Agent's own `/healthz` task count staying `0`
throughout (proof, not inference, it was never contacted); **(b)** no key
configured (default-enabled) → `assignedAgent: "planning-agent"`, the
exact same 4-step deterministic plan this phrasing has produced since
`026`'s own verification — byte-identical fallback output, not just "no
crash"; **(c)** explicit `ORCHESTRAI_ORCHESTRATOR_GRAPH=0` with a real key
present → still `assignedAgent: "planning-agent"` despite a working key,
proving a genuine opt-out rather than a coincidental no-key fallback. All
three reached a real approval gate on the resulting `dockerize` step and
were rejected with no file written. One live-verification-methodology
finding along the way, not a `038` regression: rejecting directly via an
agent's own `/tasks/:id/reject` (bypassing the Orchestrator) produces
`028`'s own `failed-ambiguous` classification, exactly as that spec's
adversarial design intends — the Orchestrator's own reject endpoint is
required for a clean terminal rejection. See
`specs/038-supervisor-default-and-planning-retirement/spec.md`'s
Verification Results for the full record, including a genuine
stale-plan-document bug (`plan.md` still described the original,
pre-revision Option B scope) found and fixed before implementation began.
Historical record only: scenarios (b) and (c) above describe the
fallback/opt-out behavior `specs/051` later removed entirely — see
"Planning Agent (retired)" above.

See specs/028-orchestrator-langgraph-supervisor/verification.md for the relocated narrative covering this checkpoint.

See specs/105-orchestrator-fallback-deep-analysis/verification.md for the relocated narrative covering this checkpoint.
