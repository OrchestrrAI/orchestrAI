---
id: 048-guided-init-experience
title: Guided Init — TUI Setup Form and Launch Handoff
area: supervisor
change_type: enhancement
status: implemented
verification: partial
created: 2026-09-04
updated: 2026-09-05
approved_by: Yusuf
approved_on: 2026-09-04
implemented_on: 2026-09-04
amends:
  - 031-interactive-init-wizard
  - 034-init-wizard-services-ux
supersedes: []
superseded_by: []
related:
  - 012-tui-interactive
  - 016-orchestrai-supervisor
  - 017-standalone-binary-distribution
  - 018-supervisor-project-path
  - 032-npm-package-distribution
  - 039-per-component-llm-provider-config
  - 047-tui-conversation-operations-navigation
  - 049-guided-init-web-setup
---

# Spec: Guided Init — TUI Setup Form and Launch Handoff

> Review gate: **APPROVED 2026-09-04 by Yusuf.** Implementation in progress —
> see `plan.md` for phases and their exit gates.
>
> Terminal-only checkpoint. The browser setup surface Yusuf also asked for is
> `specs/049-guided-init-web-setup/spec.md` — a separate spec on purpose,
> following the exact precedent specs/046 (browser) and 047 (TUI) already set
> for one concept across two surfaces. Approving this one does not authorize
> that one, or vice versa.

## Purpose

Yusuf's requirement, verbatim: *"I need when someone just download the package
and runs init to get the GUI, not the terminal asking."*

Today `npx orchestrai init` is a sequence of typed questions scrolling down a
terminal. For someone who just installed the package, that is the entire first
impression of a product whose own surfaces (the TUI's bordered panes, the
dashboards' cards) look nothing like it. This replaces the question stream with
a real full-screen setup form — fields you navigate, a live agent list you
toggle, a review pane that's always visible — and ends by actually starting the
stack, so `init` is the only command a new user has to type.

## Verified Current State

Read directly from the code on 2026-09-04, not assumed.

- `apps/supervisor/init-wizard.ts` is plain `console.log` plus a hand-rolled
  raw-stdin reader. It never imports OpenTUI or React and never calls
  `createCliRenderer()`. Its header comment records that
  `node:readline/promises` was tried and **dropped after live testing found its
  `question()` broken** for this use.
- `runInitWizardInner()` ends with `Saved. Run "orchestrai" (no flags) from
  <path>` and returns `void`; **neither it nor the exported wrapper signals
  written-vs-cancelled** — both return `undefined`.
- `dispatch()` (`apps/supervisor/index.ts`) handles `init`/`i` by awaiting the
  wizard then `return`ing. It never falls through to `main()`.
- **`main()` already re-reads the wizard's own output from disk**:
  `wizardConfigPaths(process.cwd())` → `.orchestrai/orchestrai.project.txt` and
  `.orchestrai/config.env`, filling any env var not already set. This is why
  the launch handoff below needs no new config plumbing.
- `main()` already auto-opens the TUI when `process.stdout.isTTY` and not
  `--headless`, and prints a `=== Startup summary ===` with per-service health.
- `apps/supervisor/init-wizard.test.ts` has 33 tests, all against **exported
  pure functions** (`parseServiceSelection`, `formatConfigEnv`,
  `parseConfigEnv`, path helpers). None drive the interactive loop or assert on
  printed output, so they constrain the config *contract*, not the presentation.
- **`@opentui/core@0.5.1` has no masked/password input.** Verified by reading
  `renderables/Input.d.ts` and `renderables/Textarea.d.ts`:
  `InputRenderableOptions` exposes only `value`, `minLength`, `maxLength`,
  `placeholder`; a grep for `mask|password|secret|obscure|hidden` across both
  returns nothing. This is a hard constraint, not a preference — it decides the
  API-key design below.
- `SelectRenderable` exists (`options`, `description`, `selectedIndex`,
  `showScrollIndicator`, `wrapSelection`) but is **single-select** — its only
  selection action is `select-current`. A multi-select agent list is built from
  plain boxes/text plus local state, not from `SelectRenderable`.
- specs/047 established a working PTY verification harness for exactly this kind
  of full-screen terminal work (`plan.md`'s "PTY Verification Harness" section),
  including a real screen-buffer emulator. It is reused here rather than
  reinvented.

## Proposed Behavior

### 1. `orchestrai init` opens a full-screen setup form

```text
┌─ OrchestrAI Setup ───────────────────────────────────────────────┐
│                                                                  │
│  ╔═╗╦═╗╔═╗╦ ╦╔═╗╔═╗╔╦╗╦═╗╔═╗╦    Local multi-agent orchestration │
│  ║ ║╠╦╝║  ╠═╣║╣ ╚═╗ ║ ╠╦╝╠═╣║     for your SDLC                  │
│  ╚═╝╩╚═╚═╝╩ ╩╚═╝╚═╝ ╩ ╩╚═╩ ╩╩                                    │
│                                                                  │
│  ▸ Target project                                                │
│    ┌────────────────────────────────────────────────────────┐    │
│    │ C:\Users\moham\my-app                                  │    │
│    └────────────────────────────────────────────────────────┘    │
│                                                                  │
│    Agents                            ↑↓ move · space toggle      │
│    [x] planning-agent      plan-task, suggest-agents             │
│    [x] devops-agent        dockerize, create-ci, git-status, …   │
│    [ ] testing-agent       run-tests, check-coverage             │
│    [ ] documentation-agent generate-readme, document-api         │
│    [ ] security-agent      scan-secrets, audit-dependencies      │
│    orchestrator and mcp:http are always included.                │
│                                                                  │
│    LLM planning harness        ( ) off   (•) on                  │
│    Adaptive planner            ( ) off   (•) on                  │
│    Provider                    ‹ gemini ›   anthropic · openai   │
│    Model                       gemini-2.5-pro                    │
│    API key                     not set — Enter to set securely   │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Tab/↑↓ move · Space toggle · ‹ › choose · Enter edit            │
│  ^S save and start · ^X save only · Esc cancel                   │
└──────────────────────────────────────────────────────────────────┘
```

- One screen, no wizard steps. Every answer is visible and revisable at any
  time, which a linear prompt sequence cannot do.
- Field types: text (`InputRenderable`) for path and model, a multi-select list
  for agents, two-state toggles for the harness/supervisor, a cycling choice for
  provider, and the key field described in §3.
- Agent rows show each agent's real advertised skill ids. **Correction, found
  while implementing**: the spec originally claimed these come from the
  `AGENTS` registry `dispatch()` already passes in — checked against the real
  code and that is wrong. `apps/supervisor/index.ts`'s own `AGENTS` is
  `{name, scriptRelPath, port, dependsOnMcp}`; it carries no skills. Each
  agent's real skill list lives in that agent's own unexported `agentCard` in
  `packages/agents/*/index.ts` — importing one of those modules just to read a
  static array would pull in its entire dependency graph (Hono app, MCP
  client, route handlers) into the supervisor/wizard bundle for a display
  string. Instead: a small new static file, `apps/supervisor/agent-catalog.ts`,
  exporting each agent's name and skill ids as plain data, **display-only,
  never consulted for routing/dispatch** — the same duplication this codebase
  already accepts elsewhere (CLAUDE.md's own "Agent logic and MCP templates
  are duplicated" limitation), scoped to five short id lists.
- Validation is live and inline: a non-existent target path marks that field and
  blocks save, rather than re-asking after the fact.
- The footer states the exact keys. `^S` saves and starts; `^X` saves and exits
  without starting; `Esc` cancels with nothing written.

### 2. Layout discipline inherited from specs/012 and 047

This is the third full-screen surface in this codebase, and the two before it
both hit real overflow/corruption bugs. Non-negotiable, carried over verbatim:

- **No explicit root width/height from `useTerminalDimensions()`** — the exact
  eleventh-round regression documented in `apps/tui/index.tsx`.
- **No `flexGrow`/`flexShrink` on a scrollbox** — specs/047's own Phase 2 fix
  found this corrupts rows rendered above it. Any scrollable region gets an
  explicit computed height, budgeted like `computeTaskWindow()`.
- Every long value is bounded/truncated, never wrapped, so a narrow terminal
  cannot push content past the terminal height (specs/047 Phase 2's second fix).
- Minimum supported viewport **80×24**; below it, a single clear
  "terminal too small" message with current and required size — never a
  corrupted partial layout.

### 3. The API key — the one genuinely constrained field

OpenTUI cannot mask input (verified above). Three options were considered:

| Option | Verdict |
|---|---|
| Type the key into a normal OpenTUI `Input` | **Rejected.** It would render the secret in cleartext on screen and into scrollback. |
| Hand-build a masked field: feed `•` to `InputRenderable`, track the real value separately | **Rejected for this checkpoint.** Requires diffing `onChange` against a shadow buffer; paste, mid-string backspace, and cursor movement each break naive diffing. That is new secret-handling code in the onboarding path, which is the worst place to invent it. |
| Hand off to the existing, proven masked reader | **Chosen.** |

**Chosen design.** The key field is an action, not a text box. Pressing Enter on
it suspends the renderer, runs the **existing, untouched** `promptMasked` raw-
stdin reader on the plain terminal (`*` echo, backspace, Ctrl+C — all the
behavior specs/031 already live-verified with Yusuf), then restores the form
with the field showing the existing `maskKey()` output.

Note on `maskKey()`: it returns a fixed-length `••••••••` and its own comment
states "never a partial reveal". A partial reveal (`AIza…3f7c`) would be a
**weakening** of an existing deliberate decision and is not adopted here — the
form displays exactly what the wizard already displays.

- The renderer suspend/restore boundary is the one novel mechanism here, so it
  gets its own acceptance criterion and live verification.
- If suspend/restore proves unreliable in real terminals, the documented
  fallback is to collect the key *after* the form closes, immediately before the
  write — same reader, no renderer interaction at all. Choosing the fallback is
  an implementation decision, not a spec change.
- No raw key is ever rendered by OpenTUI, written to scrollback, or logged.

### 4. Save, then launch

`^S` writes the config through the **existing** `writeWizardConfig`, then
`dispatch()` calls the **existing** `main()` — same process, same `cwd`, so
`main()` re-reads exactly what was just written. Services start, the startup
summary prints, and on a real TTY the specs/047 workspace TUI opens on its own.
`init` becomes the only command typed.

`^X` writes and prints today's exact `Run "orchestrai" (no flags) from <path>`
message. `Esc` writes nothing and never launches.

To make that branch expressible, `runInitWizard` changes from returning `void`
to returning `{ outcome: "started" | "saved" | "cancelled", targetPath }`. That
is the only signature change.

### 5. Non-TTY keeps the current wizard, unchanged

When `process.stdout.isTTY` is false (piped, redirected, CI, `bunx` inside a
script), `init` runs **today's existing prompt wizard**, byte-for-byte, and
never launches anything. The form is an additive path for real terminals, not a
replacement for the scriptable one. `--classic` forces the prompt wizard in a
real terminal too.

This is what keeps the 33 existing tests and any scripted install honest.

## Safety Constraints

- **The raw stdin reader is not modified.** `promptLine`/`promptMasked` and
  their echo/backspace/Ctrl+C handling stay byte-for-byte identical.
- **No secret through OpenTUI.** The key reaches only the existing masked
  reader; it is displayed only via `maskKey()`; it never appears in a log line,
  an error, or scrollback.
- **No new dependency.** OpenTUI and React are already bundled for `apps/tui`.
- **The launch handoff calls `main()` and nothing else** — no copied startup
  logic, no second config path, no new env var.
- **Cancel means cancel.** `Esc`, `Ctrl+C`, or a failed validation never writes
  and never starts services.
- **Non-TTY cannot launch.** A piped run gets the classic wizard and exits.
- **What gets written is unchanged** — same questions, same file format, same
  location, same precedence (specs/018/031), same plaintext-key decision, whose
  warning is shown prominently in the review area before saving.
- **Layout rules from specs/012/047 are inherited, not re-litigated** (§2).

## Out of Scope

- The browser setup surface — that is specs/049.
- Changing what is asked, what is written, the config format/location, the
  resolution precedence, or the plaintext-key decision.
- Any change to `main()`'s startup sequence, port preflight, health gating, TUI
  auto-open rule, or shutdown.
- Restyling the supervisor's startup summary or agent logs.
- Editing `apps/tui/index.tsx`'s own workspace (specs/047's open phases).

## Acceptance Criteria

- [ ] Yusuf explicitly approves this spec before implementation.
- [ ] `orchestrai init` in a real terminal opens the full-screen form; the
      classic prompt wizard runs unchanged under non-TTY and under `--classic`.
- [ ] All fields are navigable and revisable in any order; agent rows show each
      agent's real skill ids from `apps/supervisor/agent-catalog.ts`, matching
      the corresponding `agentCard.skills` in each `packages/agents/*/index.ts`.
- [ ] Invalid target path is flagged inline and blocks save, without discarding
      other answers.
- [ ] The API key is entered through the existing masked reader, displays only
      as `maskKey()` output, and never appears raw on screen, in scrollback, or
      in any log.
- [ ] `^S` writes the config and starts the stack in the same process via the
      existing `main()`, with the just-written config in effect — verified by
      the started services matching the chosen subset and the resolved path.
- [ ] `^X` writes and prints the existing manual-run message without starting.
- [ ] `Esc` and `Ctrl+C` write nothing and start nothing, at every field.
- [ ] The written `config.env` is **byte-identical** to what today's wizard
      writes for the same answers.
- [ ] At 80×24 the form renders without overflow or corruption; below it, a
      clear minimum-size message appears; no explicit root sizing and no
      `flexGrow` scrollbox is introduced.
- [ ] The existing 33 wizard tests pass unmodified; new pure tests cover the
      form's own state reducers and the written/saved/cancelled outcome.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check`, `bun run build`
      pass; the compiled binary shows the same experience as dev mode.

## Verification Plan

- **Pure tests:** form state reducers (field focus order, agent toggling,
  provider cycling, validation gating), the outcome value, and config
  formatting — all without a renderer, matching `apps/tui/tui-state.ts`'s own
  established pattern.
- **PTY harness (specs/047's recipe, reused):** drive the real form under a
  pseudo-terminal with a screen-buffer emulator at 80×24 and above — field
  navigation, agent toggling, validation blocking save, `Esc`, and the
  below-minimum state. Captured buffers recorded as evidence.
- **Byte-comparison:** drive the same answers through the classic wizard and the
  form; assert the two written `config.env` files are identical.
- **Real terminal (Yusuf's, not substitutable):** the masked-key
  suspend/restore, `Ctrl+C` at several fields, `^S` bringing up a working stack
  and the workspace TUI with no second command, resize/zoom behavior, and a
  `bunx orchestrai init` run from a genuinely fresh directory — the actual
  first-run path this spec exists for.
- **Repository gates:** full tests, typecheck, governance, build, compiled
  `init` smoke, and no orphaned processes after a launched-then-quit run.

## Approval Requested

Approval authorizes only: the full-screen TUI setup form, the masked-key
handoff to the existing reader, the written/saved/cancelled outcome value, the
post-save launch via the existing `main()`, and the non-TTY/`--classic`
fallback to today's wizard.

It does not authorize the browser surface (specs/049), changes to the raw input
reader, changes to what is asked or written, changes to `main()`'s startup
behavior, new dependencies, or edits to the specs/047 workspace.
