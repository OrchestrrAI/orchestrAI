# Verification: Conversation-Intent Answers Are LLM-Synthesized, Not Two Fixed Strings

**Status: APPROVED by Yusuf on 2026-09-24, IMPLEMENTED and VERIFIED the
same day.**

## What was live-observed

In the TUI, once a conversation contained any past task failure and any
prior turn, every subsequent `"conversation"`-classified message ("thanks",
"thanks alot ya man", and separately "fuck you") got the identical fixed
reply naming that stale failure — the reply never varied with what was
actually typed. `buildConversationAnswer()` took `priorTurns` only to
check `.length`, never their content, and `/ask`'s Tier-0 handling
explicitly skipped `synthesizeAnswer()` for this branch (`specs/116`),
so no LLM ever saw or varied it even with a provider key configured.

## What changed

- `buildConversationAnswer()` (`apps/orchestrator/index.ts`) is now
  grounding material only — its two existing deterministic facts
  (first-contact vs. not; the real most-recent-failure record) are
  unchanged in how they're computed, but its output is no longer shown to
  the user directly.
- The Tier-0 `/ask` handler now calls `synthesizeAnswer()` for
  `"conversation"`-intent turns too (previously explicitly skipped), using
  the existing `"conversation"` `LlmComponent` (already the mechanism
  `ORCHESTRAI_CONVERSATION_LLM_MODEL`/`_PROVIDER`/`_API_KEY` target — no
  new config surface).
- When synthesis succeeds, its result **replaces** the fixed text outright
  — no `${synthesized}\n\n${raw}` stacking, unlike the `"state"`/`"failure"`
  branches (which correctly keep stacking, unaffected by this spec). This
  avoids reintroducing the exact specs/116 regression ("there is 2 person
  responding me"), which came from stacking two independently-phrased
  answers, not from synthesizing at all.
- Fail-open, unchanged mechanism: no key, a provider error, or exhausted
  grounding retries all return `null` from `synthesizeAnswer()`, and the
  branch falls back to `buildConversationAnswer()`'s exact fixed text,
  byte-identical to pre-`124` behavior.
- `ConversationTurn.summary` stays unset for this branch either way —
  nothing separate to collapse.
- Added a test-only seam, `__setTestSynthesisModel()` (mirroring the
  existing `__setTestProjectAnalysisModel()` precedent), so the fix could
  be proven with a faked `BaseChatModel` rather than only asserting call
  counts.

## Verification performed

- `bun run typecheck` — 0 errors.
- `bun test apps/orchestrator/ask-endpoint.test.ts` — 60 pass, 0 fail
  (was 59 before this spec's new test).
  - New test: with a faked synthesis model configured, "thanks" and
    "thank you" (both classified `"conversation"` by the test's keyword
    router fake) produce two different, message-derived replies
    (`"You said: thanks"` / `"You said: thank you"`), neither containing
    the old fixed grounding text, and with no `"\n\n"` join — proving
    both the content-variance fix and the no-stacking requirement.
  - Updated existing specs/097 tests: a first-contact greeting and a
    no-failure mid-conversation "hello" now correctly show
    `__getTestSynthesisCallCount()` of `1` (synthesis is attempted), not
    `0` — this suite has no real key configured, so the call still
    returns `null` and the fallback text is unchanged; only the "was the
    call attempted" assertion changed, matching the new design.
  - Updated existing specs/116 test (renamed to describe the specs/124
    behavior): with no key configured, `"thanks"` after a real recorded
    failure still returns `buildConversationAnswer()`'s exact fixed
    sentence verbatim, with no `"\n\n"` — the fail-open path, unchanged
    in content, now reached via a real (no-op in this suite) synthesis
    attempt rather than a hard skip.
- `bun test` (full suite) — 1466 pass, 2 skip (pre-existing
  Docker-daemon-gated), 1 fail, 3514 expect() calls across 86 files. The
  one failure (`packages/agents/devops/index.test.ts`, "analyze-project —
  reaches a terminal state gracefully with no live MCP server") is
  confirmed pre-existing and unrelated: reproduced identically on a clean
  `git stash` of this session's changes, in a file this spec's scope never
  touches.
- `bun run specs:catalog` then `specs:check` — clean, 123 spec
  directories (was 122 before this spec's own creation), CLAUDE.md within
  budget (78,310 of 150,000 characters).
- `git diff --stat` confirms changes are scoped to
  `apps/orchestrator/index.ts`, `apps/orchestrator/ask-endpoint.test.ts`,
  `CLAUDE.md`, and this spec's own directory — no drive-by changes
  elsewhere.

## Known limitations / next step

- **Live check not performed in this session**: the spec's own
  Verification Plan names an optional live replay through the TUI with a
  real cheap-model key configured via `ORCHESTRAI_CONVERSATION_LLM_MODEL`
  — not done here (no interactive TTY / provider key available in this
  session). The deterministic acceptance criteria above are the real
  gate per the spec's own wording; this live check remains a good
  before-demo sanity pass but does not block `verification: verified`.
- The pre-existing `analyze-project`/no-MCP-server test flake noted above
  is unrelated to this spec and was not investigated further here.
