# Verification — 132 init keeps every provider key

Date: 2026-09-25.

## Automated

- `apps/supervisor/init-form-state.test.ts` — new block (9 tests):
  - Three registered providers, none used by a row, all write
    `ORCHESTRAI_<PROVIDER>_API_KEY`.
  - A save then reopen restores all three with their own keys.
  - The per-provider variables are owned, so unregistering removes the
    line.
  - ←/→ on the default row cycles the default and never swaps keys.
  - A component with its own model stays pinned to the old provider.
  - A single provider has nothing to cycle.
  - `cycleRowProvider` dispatches per row, and the default row can open
    the picker.
  - A pre-132 config still loads its override providers and gains the
    new lines on save.
- `apps/supervisor/model-discovery.test.ts` — new block (6 tests):
  - The provider's `error.message` is appended.
  - The key is redacted, including OpenAI's partly masked echo
    (`sk-proj-ab*******wxyz`).
  - A non-JSON body gives the status alone, and a long message is
    truncated.
  - The message surfaces end to end through `listAvailableModels`.
- The two classic-wizard parity tests were updated: the classic wizard
  now also records its one key in the per-provider store.
- `bun run typecheck` 0 errors; `bun test` 1538 pass / 2 skip / 0 fail.

## Real terminal (node-pty + @xterm/headless, 110×40, scratch driver)

The scratch target was seeded with Gemini as primary plus
`ORCHESTRAI_OPENAI_API_KEY` (dummy keys, so each model list fails with the
provider's real message). Driven sequence and results:

1. **Boot.** The Providers screen shows openai `••••••••` and gemini
   (default) as registered, so the key store seeds correctly.
2. **Models, default row.** The row shows `gemini · (pick …)` under the
   header "↑↓ move · ←/→ switch provider · Enter pick model", and the
   error line reads `Gemini API returned 400 — API key not valid…`.
3. **→ on the default row.** It becomes `openai · …`, and every agent row
   reads `(shared → openai)`. The error line showed OpenAI's own masked
   echo of the key; the redaction was added after this run and is
   unit-tested.
4. **↓, then → on the orchestrator row.** It becomes `gemini · (no model yet)`.
5. **Ctrl+X.** The saved file has `ORCHESTRAI_LLM_PROVIDER=openai`, both
   `ORCHESTRAI_GEMINI_API_KEY` and `ORCHESTRAI_OPENAI_API_KEY`, and
   `ORCHESTRAI_ORCHESTRATOR_LLM_PROVIDER=gemini` with its key.

## The user's real keys

Classified by prefix and checked with the real model-discovery code; no
key value was ever printed:
- OpenAI: valid, 120 models.
- Gemini: valid, 44 models.
- Anthropic: rejected, "This API key is not scoped to a workspace…". A
  key created inside an Anthropic Console workspace is needed.

All three were imported into `C:\Users\moham\devops-mcp-server\.orchestrai\config.env`
as per-provider lines through the real `mergeConfigEnv()` (a backup was
kept in the session scratchpad). The primary triple was left as it was,
for the user to choose the default in `orchestrai init`.

## Runtime: two providers in one running stack (added 2026-09-25)

The init check above proves both keys are saved; this proves they work
together at runtime. A scratch project had OpenAI `gpt-5-mini` as the
default and Gemini `gemini-3.8-flash` on the orchestrator (the user's
real keys, written by a script that never printed them). It ran
headless on ports 5000–5008. At startup, `devops-agent` resolved
`openai / gpt-5-mini` and the orchestrator's planner resolved
`gemini / gemini-3.8-flash`.

1. **Chat, both providers in one request.** "hi! what can you help me
   with?" → the Gemini router classified it (`state:question`), and OpenAI
   (the conversation component) wrote the prose answer.
2. **Agent on OpenAI.** "analyze the project at …" → Gemini routed it to
   `analyze-project`; the DevOps harness (OpenAI) produced a grounded
   Codebase Analysis naming `src/math.ts` and the Bun test script.
3. **Gemini planner driving an OpenAI agent.** "check the git status
   and also check the docker status …" → `plan-task`; the Gemini
   supervisor dispatched `git-status` and `docker-status` to
   `devops-agent`, both completed, and the composed report was accurate
   (not a git repo; Docker not running).

**Caveat found on the way.** The first run picked `gemini-2.5-flash`,
which Gemini's model list still returns, but which a real call rejects
with "no longer available to new users … use models/gemini-3.8-flash".
The router then failed silently (the chat said "couldn't tell what you
meant"). A model the provider lists is not guaranteed callable, and the
router swallows this error without logging. Both are follow-ups, not
fixed here.
