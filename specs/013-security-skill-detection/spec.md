---
id: 013-security-skill-detection
title: Broaden Security Agent's Own Skill Detection
area: security-agent
change_type: fix
status: implemented
verification: verified
created: 2026-08-09
updated: 2026-08-16
approved_by: Yusuf
approved_on: 2026-08-09
implemented_on: 2026-08-09
amends:
  - 003-security-agent
supersedes: []
superseded_by: []
related:
  - 003-security-agent
---

# Spec: Broaden Security Agent's Own Skill Detection

> Status: **APPROVED ("Approved as written") and IMPLEMENTED on 2026-08-09.
> See Verification Results below.**

## Purpose

Yusuf reported, after live-testing the TUI's new direct-to-agent
submission feature: "in the security agent it doesn't do anything almost
all prompts are unknown". Confirmed as a real, pre-existing gap in Security
Agent's own code, not a TUI bug.

## Verified Current Behavior

`packages/agents/security/index.ts:61-67`:

```ts
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("secret"))                             return "scan-secrets"
  if (lower.includes("gitignore"))                           return "check-gitignore-coverage"
  if (lower.includes("depend") || lower.includes("audit"))   return "audit-dependencies"
  return "unknown"
}
```

Any text not containing one of these three literal substrings falls
through to `"unknown"`, and the task handler (`index.ts:308`) completes it
with `result: 'Skill "unknown" not implemented yet'` rather than running
anything.

**Why this was invisible until now:** every previous path to Security
already required roughly the same keyword to arrive in the first place:

- Through the Orchestrator, `detectSkill()` there (`apps/orchestrator/
  index.ts:131-133`) only routes to Security at all on `"secret"` or
  `"audit"` (plus a `"gitignore" && "coverage"` combo) — i.e. the exact same
  narrow set. If it routed there, the keyword was already present.
- Through Security's own dashboard, the three quick-task buttons send fixed
  preset text ("Scan for Secrets", "Check .gitignore", "Audit
  Dependencies") that always matches by construction.

The TUI's new direct-to-agent submission (this session) is the first path
where someone deliberately picks **which agent** without needing to also
guess that agent's internal keyword — by definition they already know
they're talking to Security, so naturally they type "scan", "security
check my project", or similar, expecting the agent itself to figure out
which of its three skills that means. Every one of those currently falls
through to `unknown`.

## Proposed Behavior

Broaden `detectSkill()` in `packages/agents/security/index.ts` only (this
spec's scope is Security specifically, matching the reported symptom — see
Non-Goals). Proposed additional trigger words per skill, checked in this
order (most specific/least ambiguous first, matching the existing file's
own style):

```ts
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("gitignore"))                                                    return "check-gitignore-coverage"
  if (lower.includes("depend") || lower.includes("audit") || lower.includes("vulnerab") || lower.includes("package"))
                                                                                        return "audit-dependencies"
  if (lower.includes("secret") || lower.includes("scan") || lower.includes("credential") ||
      lower.includes("leak") || lower.includes("security") || lower.includes("secure"))
                                                                                        return "scan-secrets"
  return "unknown"
}
```

Reasoning for each addition:

- `scan-secrets` — this is Security's flagship/default skill (its own
  dashboard lists it first); "scan" bare, "security check", "secure my
  project" are the most natural free-form phrasings for "check this project
  for security problems" and should land here, not `unknown`.
- `audit-dependencies` — `"vulnerab"` (vulnerable/vulnerability) and
  `"package"` are natural phrasings for a dependency audit that don't
  contain "audit" or "depend" literally (e.g. "check my packages for
  vulnerabilities").
- `check-gitignore-coverage` — left as-is (`"gitignore"` alone); this is
  already an unambiguous, specific-enough term and moved first in the
  `if`/`else if` chain only so a future addition of a broader gitignore
  synonym doesn't get shadowed by the broadened `scan-secrets` branch below
  it (no functional change to this branch's own trigger set is proposed).
- Ordering: `gitignore` first (most specific), then `audit-dependencies`,
  then the now-broader `scan-secrets` last — since `scan-secrets`'s new
  triggers (`"security"`, `"scan"`) are the most generic of the three and
  should not shadow the other two if a sentence happens to contain both
  (e.g. "audit dependencies and scan for issues" should still hit `audit-
  dependencies` first since it's checked earlier).

## Safety Constraints

- No change to *what* any skill does once selected — only which skill a
  given free-text request maps to. All three skills remain read-only
  (secret scan, `.gitignore` coverage check, dependency audit) — this spec
  does not touch execution, only routing-within-the-agent.
- No change to the Orchestrator's own routing keywords, Planning's plan
  generation triggers, or any other agent's `detectSkill()` — scope is
  `packages/agents/security/index.ts` only.
- No change to approval policy — Security's skills remain unauthenticated
  read-only operations requiring no approval, unchanged.

## In Scope

1. Broaden `detectSkill()` in `packages/agents/security/index.ts` per the
   proposed keyword set above.
2. A focused regression check: every existing trigger word continues to
   match its existing skill (no narrowing), plus the new words route
   correctly, plus a genuinely nonsense string still returns `"unknown"`.

## Out of Scope / Non-Goals

- **Not** widening DevOps, Testing, or Documentation's own `detectSkill()`
  in this spec, even though they have the same `if`/`else`-chain-to-
  `"unknown"` shape — DevOps's is already fairly broad (6 skills, many
  synonyms already present); Testing and Documentation weren't reported as
  problems. If the same complaint surfaces for one of them, it gets its own
  small spec rather than being bundled in here.
- **Not** changing the Orchestrator's or Planning's own keyword sets —
  those already have their own approved specs (`specs/008-routing-fixes/spec.md`)
  and deliberately-narrow-for-a-reason triggers; touching them risks
  regressing already-demoed plan step counts, which is explicitly called
  out as a constraint there.
- **Not** adding fuzzy matching, synonyms via a dictionary, or any
  LLM-based intent classification — stays deterministic keyword matching,
  consistent with "There are no LLM API calls in the current runtime"
  (CLAUDE.md).
- **Not** changing what happens for a genuinely unmatched request (still
  `status: "completed"` with a `'Skill "unknown" not implemented yet'`
  result, not `"failed"` — see prior discussion this session; kept as-is
  per Yusuf's explicit "will keep it" decision).

## Acceptance Criteria

- [x] Yusuf approves this spec ("Approved as written").
- [x] `detectSkill()` updated in `packages/agents/security/index.ts` per
      the approved keyword set.
- [x] Manual/scripted check: each of "scan", "security check my project",
      "scan for secrets", "check my packages for vulnerabilities", "audit
      dependencies", "check gitignore", and a nonsense string ("banana")
      route to `scan-secrets`, `scan-secrets`, `scan-secrets`,
      `audit-dependencies`, `audit-dependencies`, `check-gitignore-
      coverage`, and `unknown` respectively.
- [x] `bun test` remains fully green.
- [x] Live check: submit "scan" directly to Security via curl and confirm
      it now runs a real secret scan instead of returning
      "not implemented yet".

## Verification Results (2026-08-09)

- Extracted the exact updated `detectSkill()` into a standalone script and
  ran all 7 acceptance-criteria cases — all passed, including the negative
  case (`"banana"` → `unknown`, confirming no over-broadening).
- `bun build packages/agents/security/index.ts --no-bundle --target=bun` —
  transpiled cleanly.
- `bun test`: 104 pass, 0 fail, 168 expectations, 12 files — unchanged (no
  existing test covers this agent's `detectSkill()` directly; behavior
  confirmed live instead, below).
- Live, end-to-end verification: started `security-agent` standalone with
  `ORCHESTRAI_PROJECT_PATH` set to this repo, then `curl`-submitted 4 real
  tasks directly to it:
  - `"scan"` → `completed`, real `=== Secret Scan ===` output (46 files
    scanned, real findings) — previously would have been `unknown`.
  - `"security check my project"` → same, a real secret scan.
  - `"banana"` → `completed` with `Skill "unknown" not implemented yet` —
    confirms the broadening didn't over-match nonsense input.
  - (An earlier attempt without `ORCHESTRAI_PROJECT_PATH` set correctly
    still recognized `"scan"` as `scan-secrets` and failed only on target-
    path resolution — proving the routing fix itself, independent of the
    unrelated env-var precondition.)
- Also cleaned up two stale `security-agent` processes left listening on
  port 3005 from earlier verification rounds in this session (discovered
  via `EADDRINUSE` on restart) before running the final clean check.

## Review Request

Before implementation, Yusuf should explicitly answer:

```text
Approved specs/013-security-skill-detection/spec.md as written.
```

or list specific keyword changes needed.
