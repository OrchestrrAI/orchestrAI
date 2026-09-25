# Verification: TUI and Guided-Init Bracketed Paste Support

Date: 2026-09-06 (Phase 1), 2026-09-07 (Phase 2)

Result: **verified**. Both phases complete.

## Phase 2 — implementation (2026-09-07)

### What changed

- `packages/shared/paste-text.ts` (new) — `normalizePastedText(raw,
  {singleLine, maxLength})`: normalizes line endings, strips every C0
  control byte except `\n` (structural keybinding-injection prevention
  — pasted content never reaches a buffer carrying a byte that could
  later be misinterpreted as a control sequence), strips `\n` itself
  for single-line fields, and rejects (never truncates) content over a
  bound (default 10,000 characters).
- `apps/supervisor/init-form.tsx` — a real second finding here (see
  "Phase 2 Finding" in `spec.md`): the TUI's own chat input/composer
  need **zero changes** (already native `<input>` components with
  working built-in paste). This file's own hand-rolled target-path/
  model-name/per-component-override fields gained a `usePaste()`
  handler appending the normalized text to whichever field currently
  has focus; a rejected (oversized) paste sets a new local, UI-only
  `pasteError` state rendered as a real, visible `FieldRow` error,
  cleared on the next keystroke or successful paste.
- `apps/supervisor/init-wizard.ts`'s `promptLine()` — extended (not
  replaced) to recognize `\x1b[200~`/`\x1b[201~` markers directly in its
  existing raw-stdin byte stream, accumulating across a marker split
  across multiple `data` events, and inserting the normalized content
  as one atomic operation via the same `normalizePastedText()` helper.
  The pre-existing per-character loop (Ctrl+C, Enter, Backspace,
  printable-char handling) is extracted verbatim into
  `processPlainChars()`, unchanged in behavior — only its packaging
  changed.

### Verified

- `bun run typecheck` — 0 errors.
- `bun test` — 791 pass, 0 fail, 1537 expectations across 54 files (up
  from 780/1524: 11 new `paste-text.test.ts` cases covering line-ending
  normalization, single-line vs. multi-line stripping, C0-control
  stripping including a simulated pasted Ctrl+C byte, bound enforcement
  at/over the limit, a custom `maxLength`, and control-byte noise not
  counting against the length bound).
- **Live PTY verification against the real, unmodified production
  files** (not repros) — three separate real checks, each isolating a
  different genuinely new or newly-confirmed code path:
  1. **TUI chat input** (`apps/tui/index.tsx`, unmodified): a real
     bracketed-paste sequence with an embedded newline
     (`"build and deploy\nmy app"`) arrived as
     `"build and deploymy app"` — newline correctly stripped by the
     native `<input>`'s own built-in `handlePaste`; typing `" NOW"`
     immediately after correctly appended
     (`"build and deploymy app NOW"`) — paste and keyboard input
     coexist without interference in the real production component.
  2. **`init-form.tsx`'s target-path field**: a real path containing
     spaces (`C:\Users\moham\My Project\src`) with an embedded trailing
     newline pasted via `usePaste()` arrived correctly, newline
     stripped, rendered with the correct cursor glyph; typing `"END"`
     immediately after appended cleanly.
  3. **`promptLine()`'s masked-key reader**: a real fake secret
     (`sk-FAKE-1234567890ABCDEF`) with an embedded newline, sent
     **split across two separate `data` writes** (exercising the
     cross-chunk accumulation path specifically), resolved to the
     exact expected value with the newline stripped
     (`"sk-FAKE-1234567890ABCDEFEXTRA"`). The captured raw terminal
     output byte for byte contained **only `*` characters** — the real
     secret text never appeared on screen or in any captured output at
     any point.
- All spike files (a repro app and driver scripts, placed temporarily
  at the repo root / session scratchpad to resolve module resolution
  against the real installed packages) were deleted before this commit
  — confirmed via `git status` showing no stray files each time.

### Acceptance criteria

All checked in `spec.md` — see that file's own Acceptance Criteria
section for the evidence attached to each one individually.

## Phase 1 — research spike (2026-09-06)

Date: 2026-09-06

Result: **Phase 1 complete, verified.**

## What Phase 1 found

The spec's own drafting-time search concluded no `usePaste`-shaped
export existed in `@opentui/react`. That was an incomplete search, not
a correct finding — corrected here:

- `usePaste(handler)` is a real, exported, documented hook in the
  installed `@opentui/react@0.5.1` package — confirmed in the compiled
  `index.js`'s own export list, the package's own `README.md` (a
  dedicated `#### usePaste(handler)` section with a working code
  example), and `src/hooks/use-paste.d.ts`'s type declaration
  (`(handler: (event: PasteEvent) => void) => void`).
- Its implementation subscribes to `keyHandler.on("paste", ...)` —
  structurally identical to `useKeyboard()`'s own
  `keyHandler.on("keypress", ...)` subscription, the exact hook already
  used throughout `apps/tui/index.tsx` and
  `apps/supervisor/init-form.tsx`.

## Live PTY verification (not simulated)

A minimal, application-free repro component (`usePaste` + `useKeyboard`
registered together, following this spec's own required methodology —
the same rigor `specs/048`'s own `@opentui/core` investigation used) was
driven under a real `node-pty` PTY at 80×24:

1. A genuine bracketed-paste byte sequence was written directly to the
   PTY: `\x1b[200~line one\nline two with spaces and a/b\c\x1b[201~`
   (a real start marker, real multi-line pasted content including a
   backslash and spaces, real end marker — not a fabricated keystroke
   burst).
2. The registered `usePaste` handler fired and
   `decodePasteBytes(event.bytes)` produced the **exact original text**,
   byte for byte: `"line one\nline two with spaces and a/b\\c"` — no
   ANSI leakage, no corruption, embedded newline preserved.
3. Immediately afterward, an ordinary keypress (`"x"`) was sent, and the
   registered `useKeyboard` handler fired normally with it — proving
   paste and keyboard handling coexist without interference under a
   real PTY, not just by code-shape inspection.

Raw evidence: `spec059-paste-events.log` (session scratchpad, not
committed — matches this repo's own convention that scratch PTY
evidence lives in the working `evidence-*` directories only when tied
to a spec that reached full implementation; Phase 1 here is a resolved
research question, recorded in prose above, not a shipped feature
needing its own evidence directory yet).

## Conclusion and what changes for Phase 2

The spec's own two candidate integration mechanisms (a genuine
`@opentui/react` hook, or falling back to raw-stdin interception like
`init-form.tsx`'s masked-key reader) resolve in the **more favorable**
direction: a genuine, safe, hook-based integration point exists for
every React-rendered field in this codebase. Phase 2 does not need the
riskier raw-stdin approach at all for the TUI chat input, task
composer, or guided-init's target-path/model fields — all of which are
real `@opentui/react` components.

**Not yet resolved by this spike**: the masked API-key reader
(`promptLine`/`collectMaskedKeyFromTerminal` in `init-form.tsx`) runs
during `CliRenderer.suspend()`, i.e. with **no live React tree
mounted at all** during that read — `usePaste()` cannot fire in that
window since there is no `keyHandler` context to subscribe to. That
one surface may still need the raw-stdin bracketed-paste interception
this spec originally anticipated, or may be reasonably descoped to
"masked-key paste not supported, type it" — a Phase 2 decision, not
resolved here.

**Not yet exercised**: splicing decoded paste text into an existing
hand-rolled string buffer at the correct cursor position — this repro's
`<text>` component has no buffer of its own, only proving the event
arrives with correct content. That is Phase 2's own real integration
work.

## Acceptance criteria status (as of Phase 1)

- [x] Phase 1's research question is answered with real evidence: a
      genuine, working hook (`usePaste`) is found and confirmed live —
      not confirmed infeasible.
- Every other Acceptance Criterion was Phase 2 work at this point —
  **see the Phase 2 section above for the completed record; all are now
  checked in `spec.md`.**

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/059-tui-bracketed-paste-support/spec.md` (implemented,
**verified**) added real terminal-paste support across every text-entry
surface in this codebase. Phase 1 resolved a real open question found
while drafting: does `@opentui/react` expose any hook for a hand-rolled
component to receive a terminal paste event? The answer, confirmed
against the installed package and a real PTY, not assumed: **yes** —
`usePaste(handler)` is a real, documented, exported hook, structurally
identical to `useKeyboard()`'s own subscription shape
(`keyHandler.on("paste", ...)` vs. `keyHandler.on("keypress", ...)`).

**A second real finding, made starting Phase 2**: the spec's own
drafting-time claim that every text field is hand-rolled was only true
for `apps/supervisor/init-form.tsx` — `apps/tui/index.tsx`'s chat input
and new-task composer are both real, native `@opentui/core` `<input>`
components, whose own built-in `handlePaste()` already decodes, strips
ANSI, and strips single-line newlines internally. **These needed zero
code changes** — live-confirmed against the real, unmodified
`apps/tui/index.tsx`: a real bracketed paste with an embedded newline
arrived correctly with the newline stripped, and normal typing
immediately after still worked.

The genuinely new work: `packages/shared/paste-text.ts`'s
`normalizePastedText()` (line-ending normalization, C0-control-byte
stripping — a pasted payload can never inject a keybinding-equivalent
byte once it's "just text" — single-line newline stripping, and a
bounded max length that rejects rather than truncates) is used by two
real integration points. `apps/supervisor/init-form.tsx`'s hand-rolled
target-path/model-name fields (and the Models view's per-component
override) gained a real `usePaste()` handler, live-confirmed with a
real path containing spaces. The masked API-key reader
(`apps/supervisor/init-wizard.ts`'s `promptLine()`) runs during
`CliRenderer.suspend()` with no live React tree mounted, so `usePaste()`
cannot reach it — extended instead (not replaced) to recognize the
bracketed-paste markers directly in its own existing raw-stdin byte
stream, including a paste split across multiple `data` events;
live-confirmed a real fake secret split across two writes resolved
correctly with the captured terminal output containing only `*`
characters, never the real value. The pre-existing per-character
keyboard loop is unchanged, only extracted into its own function.
