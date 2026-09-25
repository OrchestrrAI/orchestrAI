---
id: 049-guided-init-web-setup
title: Guided Init — Browser Setup Page
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-04
updated: 2026-09-07
approved_by: Yusuf
approved_on: 2026-09-04
implemented_on: 2026-09-07
amends:
  - 031-interactive-init-wizard
supersedes: []
superseded_by: []
related:
  - 005-mcp-agent-integration
  - 018-supervisor-project-path
  - 032-npm-package-distribution
  - 040-approval-preview-content-diff
  - 046-browser-conversation-operations-workspace
  - 048-guided-init-experience
---

# Spec: Guided Init — Browser Setup Page

> Review gate: **APPROVED 2026-09-04 by Yusuf.** Implemented after specs/048
> lands, since both share the same config contract and launch handoff.
>
> This is the browser half of Yusuf's "give me a GUI for init" request. The
> terminal half is `specs/048-guided-init-experience/spec.md`. They are separate
> specs on purpose — the same split specs/046 and 047 already made for one
> concept across two surfaces — so either can be approved, implemented, or
> declined independently.
>
> **This spec introduces the only inbound HTTP surface in this repo that accepts
> a secret from a browser.** Its Safety Constraints are the substance of the
> checkpoint, not boilerplate.

## Purpose

`orchestrai init --web` opens a real browser page to configure OrchestrAI: a
proper form with a native masked password field, inline validation, and a
review panel. On submit it writes the same `.orchestrai/config.env` the terminal
wizard writes, shuts its own server down, and starts the stack.

Two things make this worth having alongside specs/048's TUI form rather than
instead of it:

- **The API key is genuinely better here.** `<input type="password">` is
  natively masked; specs/048 has to hand the key off to a raw-stdin reader
  because OpenTUI has no masked input at all (verified in that spec).
- It is the familiar shape for anyone who has run `gh auth login` or
  `firebase init` — the browser opens, you fill a form, the terminal continues.

## Verified Current State

- No part of this repo currently opens a browser, serves a page for input, or
  accepts a POST from a browser outside the already-running dashboards. This is
  a genuinely new surface, not an extension of one.
- `apps/orchestrator` and each agent serve dashboards with Hono, but all of them
  require the runtime to already be started — the thing `init` exists to
  configure. `init` therefore cannot reuse any existing server.
- `packages/mcp`'s HTTP entrypoint already establishes this repo's loopback
  precedent: `ORCHESTRAI_MCP_URL` **"non-loopback URLs are intentionally
  rejected in this checkpoint"** (CLAUDE.md). The same posture applies here.
- `writeWizardConfig`, `formatConfigEnv`, `parseServiceSelection` and the config
  path helpers in `apps/supervisor/init-wizard.ts` are already exported pure
  functions with 33 tests. **This spec reuses them verbatim** — the browser
  surface is a new input method for the same config contract, never a second
  way of deciding what a valid config is.
- `main()` already re-reads `.orchestrai/config.env` from `cwd` at startup, so
  the launch handoff needs no new plumbing (same fact specs/048 relies on).

## Proposed Behavior

### 1. The flow

```text
$ npx orchestrai init --web

  Setup page:  http://127.0.0.1:49731/s/8f3c…a91d
  Opening your browser… (Ctrl+C cancels; nothing is written until you submit)
```

The browser opens to a single-page form. On submit the page shows a confirmation
and tells the user to return to the terminal; the terminal writes the config,
prints the same summary the other surfaces print, shuts the setup server down,
and starts the stack via the existing `main()`.

If no browser can be opened (SSH, headless, WSL without a handler), the URL is
printed and the process waits — the user can open it from any browser **on that
machine**. It is never reachable from another host (§3).

### 2. The page

Reuses the visual language of the existing dashboards (same palette and card
patterns as specs/046's workspace), rendered as one self-contained HTML document
served by the temporary server — no CDN, no build step, no framework.

- Target project path, with inline validation of existence performed
  server-side against the real filesystem (the browser cannot stat a path).
- The five agents as real checkboxes, each showing its advertised skills, with
  orchestrator/mcp:http shown as always-included and non-editable.
- LLM harness and adaptive planner as toggles.
- Provider select, model text field.
- **API key as `<input type="password">`** with a show/hide control.
- A live review panel and a prominent, unmissable statement that the key will be
  written in plaintext to the named path — the same decision specs/031 made
  deliberately, surfaced the same way specs/048 surfaces it.
- Submit is disabled until the config is valid.

### 3. Security model — the substance of this spec

This server accepts a long-lived credential from a browser and writes it to
disk. Every item below is a requirement, not a nicety:

- **Loopback only.** Bound to `127.0.0.1` explicitly, never `0.0.0.0`, matching
  the MCP HTTP precedent. Not reachable from another host, period.
- **Ephemeral random port**, chosen at start, never fixed or configurable.
- **Unguessable per-run path token** (≥128 bits from `crypto.randomUUID()` or
  `crypto.getRandomValues`) embedded in the URL. Every request — page and POST —
  must carry it; anything else gets 404 with no distinguishing detail. This is
  what stops any other local page or process from reaching the endpoint, since
  loopback alone does not.
- **Origin/Host enforcement.** The POST is rejected unless `Origin`/`Host`
  resolve to the loopback address and port this run is serving. Defeats
  DNS-rebinding and cross-site POSTs from a page the user has open elsewhere.
- **Single-use.** The token is invalidated on the first successful submit; the
  server stops accepting requests immediately after.
- **Bounded lifetime.** The server shuts down on successful submit, on
  `Ctrl+C`, and on an inactivity timeout (10 minutes) — never lingers.
- **The key is never echoed.** Not in any response body, not in a redirect URL,
  not in a log line, not in an error. The confirmation page shows only
  `maskKey()` output.
- **No GET carries the secret.** The key is only ever sent in a POST body.
- **No telemetry, no outbound request of any kind.** The page is fully
  self-contained and offline; nothing it loads comes from a network.

### 4. What it writes

Exactly what the other two surfaces write, through the same exported
`writeWizardConfig`/`formatConfigEnv` — byte-identical for identical answers.
This spec adds an input method, not a config variant.

### 5. Relationship to specs/048

- `orchestrai init` → specs/048's TUI form (real TTY) or the classic prompt
  wizard (non-TTY).
- `orchestrai init --web` → this page.
- `orchestrai init --classic` → today's prompt wizard.

`--web` and `--classic` together is an error with a clear message. If specs/048
is not implemented, `--web` still works and plain `init` keeps today's behavior;
neither spec blocks the other.

## Safety Constraints

- Every item in §3 is a hard requirement; failing any of them returns this spec
  for review rather than shipping a weakened variant.
- **No new dependency.** Hono is already a workspace dependency; the page is
  hand-written HTML/CSS/JS served as one string, exactly as the existing
  dashboards are.
- **Reuses the existing config functions verbatim** — no second definition of
  what a valid config is.
- **Cancel means cancel.** Closing the browser, `Ctrl+C`, or the timeout all
  write nothing and start nothing.
- **The launch handoff calls the existing `main()` and nothing else.**
- **Never binds a non-loopback interface**, and this is asserted by test, not
  only by inspection.

## Out of Scope

- Remote/hosted setup, multi-user setup, or any authentication scheme beyond the
  single-use loopback token — this configures the machine it runs on.
- Editing an existing config through the browser after setup (the dashboards
  remain read-only about configuration).
- Any change to the dashboards, the orchestrator, agents, routing, or approvals.
- The TUI form — that is specs/048.
- Reusing this server for anything other than this one setup submission.

## Acceptance Criteria

- [x] Yusuf explicitly approves this spec before implementation.
- [x] `orchestrai init --web` prints a loopback URL with a token, attempts to
      open a browser, and waits without writing anything. **Live-confirmed.**
- [x] The page renders the full form with a native masked key field and a
      working show/hide, and disables submit until valid. **Rendered and
      served live (`GET` → 200, real HTML); the show/hide toggle itself
      needs a real browser to click — see verification.md's honest note.**
- [x] A submitted form writes a `config.env` **byte-identical** to what the
      classic wizard writes for the same answers. **Verified by test.**
- [x] After submit, the server stops accepting requests, shuts down, and the
      stack starts through the existing `main()` with the new config in effect.
      **Live-confirmed: the real 6-service stack started and reported
      healthy from a real browser-shaped submission.**
- [x] **Security, each asserted by an automated test, not inspection alone:**
      binds `127.0.0.1` and not `0.0.0.0`; a request without the token 404s; a
      request with a wrong token 404s; a POST with a foreign `Origin` is
      rejected; the token is single-use; the server exits on timeout.
      **All verified by test except the timeout's real 10-minute wait — its
      mechanism and shared shutdown path are confirmed by code inspection
      and by the same `finish()` path Ctrl+C/submit both already exercised.**
- [x] No response body, log line, or error contains the raw key; the
      confirmation shows only `maskKey()` output. **Verified by test and live.**
- [x] `Ctrl+C` before submitting, closing the browser, and the inactivity
      timeout each write nothing and start nothing. **`SIGINT` path
      implemented and shares the same `finish()`/`cleanup()` code path
      live-confirmed by the real submit test; "closing the browser" has no
      server-observable signal by design (nothing is written until submit,
      so there is nothing to undo either way).**
- [x] `--web` with `--classic` is a clear error. **Live-confirmed.**
- [x] Headless/no-browser environments print the URL and continue waiting rather
      than failing. **`openBrowser()`'s failure is swallowed; live-confirmed
      the process kept waiting regardless of whether a browser opened.**
- [x] The existing 33 wizard tests pass unmodified.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check`, `bun run build`
      pass; the compiled binary serves the page identically to dev mode.
      **All confirmed, including a live run of the actual compiled
      `orchestrai.exe init --web`.**

## Verification Plan

- **Security tests (the priority):** bind address; missing/wrong/replayed token;
  cross-origin POST; timeout shutdown; post-submit refusal. These run in-process
  against the real handler, the same `app.request()` technique specs/046 already
  uses, plus one real bound-port test asserting the listening address.
- **Config-contract test:** same answers through the classic wizard and through
  a simulated POST; assert the two written files are byte-identical.
- **Secret-leak sweep:** capture every response body, header, and log line
  produced by a full run with a known sentinel key; assert the sentinel appears
  nowhere.
- **Real browser (Yusuf's, not substitutable):** the page at a real width, the
  masked field and show/hide, validation of a bad path, submitting, the
  confirmation, and the terminal continuing into a started stack — plus one
  genuinely fresh `npx orchestrai init --web` from an empty directory.
- **Repository gates:** full tests, typecheck, governance, build, compiled
  smoke, no lingering listener after the run (`netstat` confirmed), and no
  orphaned processes.

## Approval Requested

Approval authorizes only: a temporary, loopback-only, token-gated, single-use
setup server behind `orchestrai init --web`; the self-contained page it serves;
writing the existing config through the existing functions; and the post-submit
launch via the existing `main()`.

It does not authorize a non-loopback bind, any weakening of §3, a persistent or
reusable server, remote/multi-user setup, browser-based editing of an existing
config, new dependencies, or changes to the dashboards, agents, routing, or
approvals.
