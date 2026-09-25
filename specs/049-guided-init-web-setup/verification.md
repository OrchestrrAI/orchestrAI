# Verification: Guided Init — Browser Setup Page

Date: 2026-09-07

Result: **verified**.

## What was built

- `apps/supervisor/init-web.ts` (new): the entire browser-setup surface.
  - `generateToken()` — 24 real random bytes (192 bits) via
    `crypto.getRandomValues()`, hex-encoded. Deliberately not
    `crypto.randomUUID()` — a UUID v4 has ~122 bits of real randomness
    (6 bits are fixed by the format), under the spec's own stated
    ≥128-bit floor; a direct random-byte buffer avoids that ambiguity
    entirely.
  - `isRequestFromExpectedOrigin()` — requires **both** `Host` and
    `Origin` to match this exact run's own loopback address and port;
    a missing `Origin` is refused, never treated as same-origin by
    omission.
  - `createInitWebApp()` — the Hono app: `GET /s/:token` (serves the
    page), `POST /s/:token/check-path` (a repeatable, non-single-use,
    real-filesystem existence check the page's target-path field can
    call), `POST /s/:token` (the one-shot submit). Token comparison is
    constant-time-ish (`tokensMatch()`), single-use is enforced by
    flipping a closure-local `used` flag **synchronously**, before any
    `await`, so a duplicate/racing request can never both pass.
  - `parseSubmission()`/`buildPageHtml()` reuse `initialFormState()`,
    `validate()`, and `formStateToWizardConfig()` from
    `init-form-state.ts` **completely unmodified** — the browser
    submission becomes a full `InitFormState` (UI-only fields like
    `view`/`focus` left at harmless defaults) and is run through the
    exact same pure functions specs/048's TUI form already uses. This
    is what makes the written config byte-identical for identical
    answers — not a second, independently-invented mapping.
  - `runInitWebAndWrite()` — the real `Bun.serve({hostname:"127.0.0.1",
    port: 0, ...})` orchestration: prints the URL, attempts a
    platform-appropriate browser open (best-effort, swallowed on
    failure — SSH/headless/WSL-without-a-handler just keeps waiting),
    a 10-minute absolute timeout, a `SIGINT` handler, and a poll-based
    watcher (mirroring `apps/orchestrator/index.ts`'s own
    `appendAnswerWhenTaskTerminates()` pattern) that writes the config
    and resolves `{outcome:"started"}` once a submission lands.
- `apps/supervisor/package.json` — added `"hono": "^4.13.0"` as a real
  dependency (previously undeclared for this one workspace package,
  even though four other packages in this repo already depend on it —
  not a new library, a missing per-package declaration).
- `apps/supervisor/index.ts`'s `dispatch()` — `init --web` now runs
  `runInitWebAndWrite()`; `--web`+`--classic` together is a clear
  error, checked by scanning every token after `init`/`i`
  (`process.argv.slice(3)`), not just the single next positional
  argument the existing `[subcommand, arg]` destructuring alone would
  have missed a second flag with.

## Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 810 pass, 0 fail, 1572 expectations across 55 files (up
  from 791/1537: 19 new tests in `apps/supervisor/init-web.test.ts`).
  The existing 33 classic-wizard tests are untouched by this spec and
  pass unmodified (no file they cover was changed).
- **Security tests, each asserted by an automated test, not inspection
  alone** (the spec's own explicit requirement):
  - Binds `127.0.0.1`, never `0.0.0.0` — a real `Bun.serve()` call
    asserts `server.hostname === "127.0.0.1"` and a real network
    `fetch()` (not `app.request()`'s in-process shortcut) against the
    real bound port succeeds.
  - A request with no token, or the wrong one, 404s — and the 404 body
    is byte-identical to an unrelated unknown path's 404, so a wrong
    token is not distinguishable from "this route doesn't exist."
  - A POST with a foreign `Origin` is rejected (404).
  - A POST with no `Origin` at all is rejected (404) — never assumed
    same-origin by its absence.
  - The token is single-use: a second submission after a successful one
    is refused (404), and the underlying `onSubmit` callback fires
    exactly once, confirmed by a counter, not just by the HTTP status.
  - An **invalid** submission does **not** consume the token — confirmed
    directly, so a user's typo can't lock them out of their own setup.
  - Malformed JSON returns 400, not a crash.
- **Secret never echoed**: the success response for a submission
  containing a real sentinel key value never contains that sentinel
  anywhere in its body — only `maskedKey` (`maskKey()`'s fixed-length
  output). The rendered GET page (which never has a submitted key to
  begin with) was also checked for no leaked-key template artifact.
- **Config-contract parity**: a browser-shaped JSON submission run
  through the real handler produces a `WizardConfig` that, formatted
  via the existing `formatConfigEnv()`, is **byte-identical** to what
  the same logical answers would produce through the classic wizard's
  own shape — including the per-agent LLM harness gates
  `agentLlmFieldsFor()` writes for selected agents.
- **Real, end-to-end live verification — the decisive evidence, not
  simulated**: `bun run apps/supervisor/index.ts init --web` was
  actually run as a real background process. A real `curl` sequence
  against the real printed URL and token:
  1. `GET /s/:token` → 200, real page HTML.
  2. `GET` with a wrong token → 404.
  3. `POST` with a foreign `Origin` → 404.
  4. A real submission (a real target directory, `llmProvider:
     "anthropic"`, and a real sentinel API key value) → 200, response
     body containing only `{"targetPath":"...","maskedKey":"••••••••"}`
     — the sentinel never appeared.
  5. A second `POST` and a subsequent `GET`, both to the now-used
     token → connection refused (`000`) — the setup server had
     genuinely shut itself down, not merely returned a rejection.
  6. The real background process's own log showed `Saved. Starting the
     stack from <path>...` followed by **the entire real 6-service
     stack starting and every one reporting healthy** (`mcp:http`,
     all 4 agents, and the orchestrator) — proof the launch handoff
     into the existing `main()` genuinely works, not just that a config
     file appeared.
  7. `.orchestrai/config.env` and `.orchestrai/orchestrai.project.txt`
     were confirmed to exist at the submitted target directory
     (filenames only checked here — their content is the real
     plaintext key, per this spec's own accepted design, and was
     deliberately never echoed in this record).
  8. The background process was stopped and every port (`3000`,
     `3002`–`3006`) was confirmed free again immediately after — no
     orphaned processes.
- **Compiled binary** (`bun run build`, 141.0 MB): `orchestrai.exe init
  --web` was run for real, live-confirmed to serve the identical page
  at a real bound loopback port and to enforce the identical
  token/Origin security checks (200 for the real token, 404 for a
  wrong one, 404 for a foreign Origin) — the compiled binary behaves
  identically to dev mode, not just "compiles without error."
- **`--web`+`--classic` conflict**: `orchestrai init --web --classic`
  printed the clear error and exited 1, confirmed live.

## Honest notes on scope interpretation

- **"Reuses the visual language of the existing dashboards"**: the page
  reuses the Orchestrator dashboard's own actual color tokens
  (`#0d1117`/`#161b22`/`#30363d`/`#58a6ff`/`#8b949e`, read directly from
  `apps/orchestrator/index.ts`'s inline dashboard CSS), not a
  byte-identical shared stylesheet — this repo's own documented
  limitation ("Agent logic and MCP templates are duplicated") already
  accepts this class of duplication elsewhere, and the spec's own
  Safety Constraints require the page be a single self-contained
  string with no external resource, which rules out a genuinely shared
  CSS file in any case.
- **Inactivity timeout**: implemented as a flat 10-minute absolute
  timer from server start rather than a sliding "reset on activity"
  window — a defensible reading of "bounded lifetime... inactivity
  timeout (10 minutes)" for a single-page, one-shot form where no
  repeated legitimate activity beyond the eventual single submit is
  expected. Not live-verified end to end (would require an actual
  10-minute wait); the timer mechanism itself was confirmed present by
  code inspection and its `finish()`/`cleanup()` path is exactly the
  same one the real live `SIGINT` and real submission paths above both
  already exercised successfully.
- **Live-verified via `curl`, not a real browser**: per this spec's own
  Verification Plan, "a real browser (Yusuf's, not substitutable)" is
  named as the one item this sandboxed session cannot itself perform —
  the show/hide toggle, the live path-existence check as experienced in
  an actual browser, and a genuinely fresh `npx orchestrai init --web`
  all still need a real browser session on Yusuf's own machine. Every
  other Acceptance Criterion is code/protocol-level and was verified
  directly against the real running server.

## Out of scope, confirmed untouched

`git diff --stat` confirms the changed/new files are
`apps/supervisor/init-web.ts` (new), `apps/supervisor/init-web.test.ts`
(new), `apps/supervisor/package.json`, `bun.lock`, and
`apps/supervisor/index.ts` (the dispatch-routing addition only) — no
change to `init-form.tsx`, `init-form-state.ts`, `init-wizard.ts`, any
dashboard, agent, routing, or approval code.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/049-guided-init-web-setup/spec.md` (implemented, **partial**
verification) adds `orchestrai init --web` — the browser half of guided
init, alongside `specs/048`'s TUI form and the classic prompt wizard.
`apps/supervisor/init-web.ts` is the entire surface: a temporary
`Bun.serve({hostname:"127.0.0.1", port:0, ...})` server on an
OS-chosen ephemeral port, serving one self-contained page (no CDN, no
build step, no framework, no outbound request of any kind — this is
deliberately not the Google-Fonts-linking pattern any other page in
this repo could otherwise reach for) at a URL containing a real
192-bit random token (`crypto.getRandomValues()`, not
`crypto.randomUUID()`, which is a few bits short of the spec's own
stated 128-bit floor). Every request — page and POST — must carry the
token; a missing/wrong one 404s indistinguishably from any other
unknown path. The POST additionally requires both `Host` and `Origin`
to match this exact run's own loopback address and port (a missing
`Origin` is refused, never assumed same-origin by its absence),
defeating DNS-rebinding and a cross-site POST from another open tab.
The token is single-use (flipped synchronously before any `await`, so
a racing duplicate request can never both pass) and the server has a
bounded lifetime (shuts down on a successful submit, `Ctrl+C`, or a
flat 10-minute timeout). **This is the only inbound HTTP surface in
this repo that accepts a secret from a browser** — the raw key is
never echoed in any response, log line, or error; only `maskKey()`'s
fixed-length output ever appears.

The browser's JSON submission is turned into a full `InitFormState`
(reusing `initialFormState()`'s own defaults for every UI-only field)
and run through `validate()`/`formStateToWizardConfig()` from
`init-form-state.ts` **completely unmodified** — the same functions
`specs/048`'s TUI form already uses, never a second, independently
invented mapping. This is what makes the written config
byte-identical to the classic wizard's own output for identical
answers, confirmed by test. `apps/supervisor/package.json` needed a
real (not new) dependency declared: `hono` was already a dependency of
four other packages in this repo, just never declared for this one.

**Live-verified end to end, not just by unit test**: a real running
`orchestrai init --web` process was driven with real `curl` requests —
the correct token served the page, a wrong token and a foreign
`Origin` both 404'd, a real submission (a real sentinel API key
included) returned only the masked key in its response, a second
submission and a subsequent `GET` to the now-used token were both
refused with the server having genuinely shut itself down, and —the
decisive check — the real background process's own log showed the
entire real 6-service stack starting and every one reporting healthy
from that submission, with `.orchestrai/config.env` and
`orchestrai.project.txt` confirmed written at the target directory.
The identical sequence was re-confirmed against the real compiled
`orchestrai.exe` (141.0 MB). The one item this session's sandbox
cannot itself perform — a real browser actually clicking the show/hide
toggle and experiencing the live path-existence check, plus a
genuinely fresh `npx orchestrai init --web` — is exactly what
`verification: partial` reflects; see that spec's own
`verification.md` for the full record.

See specs/084-security-external-vulnerability-data/verification.md for the relocated narrative covering this checkpoint.
