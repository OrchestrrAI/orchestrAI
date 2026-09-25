# Verification: Guided Init — TUI Setup Form and Launch Handoff

Result so far: **partial**. Phases 1–4 are complete and live-verified via
the PTY harness and the compiled binary, including a genuine end-to-end
launch of a real multi-service stack. Phase 5's automated gates are done;
one **blocking-severity finding** surfaced during Phase 5 needs a decision
before this spec can be considered fully closed — see "Phase 5" below.

## Phase 1 — pure state, one config contract

`apps/supervisor/init-form-state.ts` + `init-form-state.test.ts`, 39 tests.
The load-bearing block ("one config contract — the form and the classic
wizard serialize identically") asserts byte-identical `formatConfigEnv()`
output between the form's state and the classic wizard's own answers for
three cases: "all" agents, a real subset, and a full Gemini configuration.
`bun test` passed at commit time; `bun run typecheck` clean.

## Phase 1.5 — agent skill catalog

While implementing, found the approved spec's own claim wrong: it said agent
skill hints would come from `apps/supervisor/index.ts`'s `AGENTS` registry
"already passed in" — that registry has no skills field at all. Corrected in
`spec.md` and built `apps/supervisor/agent-catalog.ts` instead: a small,
hand-copied, **display-only** mirror of each agent's real `agentCard.skills`,
never consulted for routing. Exported `agentCard` from all 5 agent modules
(one-word change each, zero behavior change) so `agent-catalog.test.ts` could
assert the catalog matches the real source rather than trusting a hand-copy.
That test caught a real transcription error on its first run: `create-compose`
and `create-ci` were swapped for `devops-agent`.

## Phase 2 — the rendered form

`apps/supervisor/init-form.tsx`. Verified with the PTY harness from specs/047
(`node-pty` + `@xterm/headless`, real screen-buffer capture, scratch-only, not
a project dependency), driving the real component through a scratch entry
point (`init-form-smoke.ts`, deleted once Phase 4 wires the real call site).

### Three real bugs found and fixed during this pass

1. **Row corruption in the fields section.** The agents+toggles+provider
   region was a plain `<box height={N} overflow="hidden">`. A live capture at
   80×24 showed this does **not** clip cleanly: rows past the box's own
   height rendered on top of earlier rows instead of being cut, merging text
   from different lines onto the same row and hiding two of the five agents
   entirely. Fixed by switching to a real `<scrollbox>` with the same computed
   (never `flexGrow`) height — the exact mechanism specs/047 Phase 2 already
   proved safe for this identical class of problem (the Chat transcript).
   Re-verified: all 5 agents visible, no overlap, at 80×24 with the full
   provider block open.
2. **A real crash** — `TextNodeRenderable only accepts strings, ... or
   StyledText instances` — the instant the LLM harness toggle revealed the
   provider/model/key block. Cause: `FieldRow`'s inline mode nested a
   `<text>` element inside another `<text>` element (the three call sites for
   Provider/Model/API key each passed a `<text>...</text>` as `children`).
   Fixed by changing those three call sites to `<span>`, which is valid
   inline content for a `<text>` parent. Re-verified: toggling the harness on
   now reveals the block cleanly with no crash.
3. **A literal doubled backslash** in the review line — `\\.orchestrai\\...`
   in JSX text is not a JS string escape (JSX text has no escape processing
   at all), so it rendered as two literal backslash characters. Fixed to a
   single `\`. Also shortened the footer key-hint line, which was ~93
   characters and wrapped onto a second row in an 80-column terminal — the
   exact "unbounded text wraps and corrupts" class specs/047 Phase 2 already
   found once; caught here before it reached a live capture with the longer
   string, fixed proactively at 75 characters.

### Auto-scroll, added because the harness surfaced the need

Switching to a real `<scrollbox>` for the fields region meant a field the
user tabs to could scroll out of view with no way back except manually
scrolling. Added `fieldScrollOffset()` (`init-form-state.ts`, 5 new tests) —
a pure function computing each field's exact row offset inside the scrollable
region, matching the renderer's own field order — and a `useEffect` that
calls `scrollTo()` on focus change. Not yet live-verified beyond visual
inspection of the capture sequence below; a dedicated navigate-to-every-field
PTY pass is a reasonable follow-up before Phase 5's real-terminal check.

### Live captures (80×24, real screen-buffer emulation)

- Boot: banner, hints, target field, all 5 agents with real skill hints, both
  toggles — clean, no overflow, matches the design exactly.
- Agent toggle: cursor and selection state both update correctly and visibly.
- Harness toggle reveals the provider block: clean, no crash (post-fix).
- Below-80×24 resize: the "terminal too small" fallback renders, but the
  capture shows fragments of the previous larger render bleeding through in
  columns beyond the new (smaller) width. **Not treated as a confirmed bug**:
  a real terminal has no columns past its own current width to show stale
  content in, so this may be specific to how the headless emulator retains an
  internal buffer wider than the "resized" viewport — the same class of
  capture-fidelity caveat specs/047's own `plan.md` already documents for this
  harness. Needs Yusuf's real resize test to confirm either way; not claimed
  as verified here.
- `Esc`: resolved cleanly to `{action: "cancel", state: {...}}` with the full,
  correctly accumulated state (the exact toggles/selections made during the
  run) and no crash on renderer teardown.

### Not yet live-verified

- Provider cycling (`‹ ›`) and typing into the Model field — the PTY script
  used to check these had its own off-by-one Tab-count bug (documented
  inline in the harness script), so what it actually captured was a repeat of
  adjacent-field navigation rather than these two specifically. The
  underlying logic (`cycleProvider`, `setText`) is fully covered by Phase 1's
  pure tests, and the rendering wiring is a few directly-readable lines, but
  the *live, rendered* behavior for these two specific interactions has not
  been captured. Worth a short follow-up capture before Phase 5's exit gate,
  not blocking Phase 3.
- The masked-key field (Phase 3 — intentionally a no-op placeholder in this
  phase's code, per the plan's own phase boundary).
- Ctrl+C specifically (only `Esc` was exercised for cancel in this pass);
  OpenTUI/Bun's SIGINT handling relative to `useKeyboard` needs a real
  terminal to confirm either way.

## Phase 3 — the masked-key handoff

`apps/supervisor/init-form.tsx`'s `collectMaskedKeyFromTerminal()` +
`runInitForm()`. Exported `promptLine` and `maskKey` from `init-wizard.ts`
(both one-line additions, zero behavior change to either) so this could call
the exact existing masked reader rather than reimplement masking.

### The first implementation was wrong, found live, not by inspection

The plan described this as "suspend the renderer entirely and hands off to
the existing masked reader," and the first attempt implemented that
literally: `root.unmount()` + `renderer.destroy()`, run `promptLine`, then
`createCliRenderer()` + `createRoot()` again from scratch for every key-entry
cycle. A live PTY run showed this **does not reliably hand stdin back**: the
masked prompt printed correctly, but typed characters never echoed as
asterisks and Enter never resolved `promptLine` at all — the screen stayed
frozen on the empty prompt through every subsequent action in the test
script.

Root-caused before attempting a second fix, not guessed: `@opentui/core`'s
`CliRenderer` has a purpose-built `suspend()`/`resume()` pair, confirmed by
reading the actual implementation (not just the `.d.ts`) in
`chunk-bun-8fkgaxc6.js`. `suspend()` synchronously removes the renderer's own
`stdin` `"data"` listener and calls `stdin.setRawMode(false)` — exactly the
two things `promptLine`'s own raw-mode reader needs released to safely take
over; `resume()` reverses both. Destroy/recreate was doing something more
complex asynchronously that never fully completed before the next
`promptLine` call raced ahead of it.

Rewrote to keep **one renderer and one React root alive for the form's
entire lifetime**, calling `renderer.suspend()` before `promptLine` and
`renderer.resume()` in a `finally` block after (so a thrown
`WizardCancelledError` from Ctrl+C still resumes correctly) — the renderer is
only ever destroyed once, at a real final outcome.

### Live-verified, real masking, real suspend/resume cycle

PTY capture at 80×24, real keystrokes, not simulated:
- Enter on the API key field genuinely suspended the renderer — the screen
  cleanly switched to the plain masked-prompt text with no leftover form
  content bleeding through.
- Typing a 22-character fake key echoed as 22 literal asterisks.
- Enter resumed the form, which then displayed the real `maskKey()` output
  (`••••••••`, fixed-length) and correctly showed the plaintext-storage
  warning line, which only appears once a key is set.
- Re-opening the prompt and sending Ctrl+C returned to the form with the
  **same** key still shown — confirming "Ctrl+C returns to the form without
  changing it" resolves as "leave whatever was already there," not "clear
  it," which was the intended reading of the spec's own wording.
- `Ctrl+S` from that state resolved to `{action: "save-and-start", state:
  {..., llmApiKey: "AIzaFAKEKEYFORTEST1234", ...}}` — the full pipeline from
  masked entry through to the final result object holding the real value,
  ready for Phase 4 to write.

`bun test` 695/695 (unchanged — this phase added no new pure-testable
surface, per the plan's own note), `bun run typecheck` 0 errors.

### Not yet exercised

- The documented fallback (collect the key after the form closes, no
  renderer interaction at all) — not needed, since `suspend()`/`resume()`
  worked. Left undisturbed in the plan as a fallback if a real terminal ever
  disagrees with this sandboxed PTY result.
- A real terminal's own confirmation of this exact sequence (Yusuf's, per
  the plan) — the mechanism is now proven correct against a real
  screen-buffer emulator with real keystrokes, but Phase 5's own real-terminal
  pass is what closes this out formally.

## Phase 4 — routing and launch handoff

`runInitWizardInner`/`runInitWizard` (`init-wizard.ts`) now return the same
`InitOutcome` (`init-form-state.ts`) shape the form already produced — the
classic wizard only ever resolves `"saved"` or `"cancelled"`, never
`"started"`, since it never launches anything, unchanged. A new
`runInitFormAndWrite()` (`init-form.tsx`) reads whatever's already saved for
the invocation directory (the same `readExistingWizardConfig()` call the
classic wizard makes), runs the form, and on anything but `"cancel"` writes
via the exact same `writeWizardConfig()` the classic wizard uses.
`dispatch()` (`index.ts`) routes `init`/`i`: `--web` rejected with a pointer
to specs/049 (not yet implemented); `--classic` or a non-TTY stdin (the same
signal `promptLine()`'s own fallback already keys on) → the unchanged
classic wizard; otherwise → the new form (dynamic `import("./init-form")`,
matching the `tui` subcommand's own existing pattern of keeping
`@opentui/react` out of every other code path's module graph). On a
`"started"` outcome, `process.chdir()`s to the resolved target, then calls
the existing `main()` in the same process — no copied startup logic, no new
env var, no change to `main()` itself. `bun test` 695/695 passed, `bun run
typecheck` 0 errors, `bun run specs:catalog`/`specs:check` clean.

### Two real bugs found live, not assumed away

1. **A genuine config-mismatch gap.** The plan's own wording ("call the
   existing `main()` in the same process") turned out to be incomplete:
   `main()` reads `<cwd>/.orchestrai/config.env`, not the target path the
   form was told about. A first live PTY run proved this concretely — a
   scratch target typed into the form differed from the directory the
   process was launched from, and the resulting `main()` call read whatever
   config already existed at the *original* cwd (leftover from earlier
   testing in this repo itself), completely ignoring what the form had just
   written. Fixed with `process.chdir(outcome.targetPath)` immediately
   before `await main()` — this is exactly what `main()`'s own comment
   already documents as the intended invocation shape ("cd my-app &&
   orchestrai"), so the fix reproduces that shape rather than inventing a
   new one. Re-verified live: `main()`'s own startup log now correctly
   names the scratch target as both the resolved project path and the
   source of the wizard config, not the original launch directory.

2. **A silent process crash, harder to find, found by isolating variables
   one at a time rather than guessed at.** With the chdir fix alone, `^S`
   still crashed the whole process — no JS exception, no exit code
   (`node-pty` reported `exitCode`/`signal` both `undefined`, consistent
   with a native-level death, not a normal `process.exit()`), non-
   deterministically at varying points shortly after `main()` began running.
   Two baseline PTY runs isolated the trigger precisely: `main()` invoked
   directly (chdir'd cwd, no renderer ever created in that process) ran
   clean end to end; the already-shipped "spawn children, then create a
   *second* `CliRenderer` for the TUI" pattern (`specs/017`'s own
   auto-launch follow-up) also ran clean under the identical harness. Only
   "create and actively use a `CliRenderer`, destroy it, then keep the
   process running and doing real I/O" crashed — the one new sequence this
   phase introduces. Root-caused by reading `@opentui/core`'s real
   `cleanupBeforeDestroy()` implementation (not guessed): it calls
   `stdin.pause()` as part of releasing raw mode and never un-pauses it —
   reasonable for a renderer that expects the process to exit shortly after
   destroy, which every prior use of this renderer in this codebase did,
   and false for the first time here. Fixed with one `process.stdin.resume()`
   immediately after the chdir, before `await main()` — undoing exactly
   what `destroy()` paused, nothing else. A related, smaller correctness
   issue was fixed alongside this while investigating: `destroy()`'s own
   real implementation defers part of its teardown (native resource
   release, `root.destroyRecursively()`, its own `"destroy"` event) to a
   later render-loop tick when called mid-render rather than finishing
   synchronously, despite its `.d.ts` promising a plain `void` return — the
   form's `finish()` now awaits the renderer's real `"destroy"` event
   (`destroyRendererAndWait()`) before resolving, instead of assuming
   `destroy()` was already complete when it returned.

### Live captures, real PTY, real screen-buffer emulation

- **Non-TTY** (`bun run` with stdin piped, not a real terminal): always the
  classic wizard, confirmed via its own plain prompt text, never the form.
  Wrote `ORCHESTRAI_ONLY=planning-agent,orchestrator` (the `orchestrator`
  append is specs/034's own rule, still intact through this path) and
  `ORCHESTRAI_LLM_HARNESS=0`/`ORCHESTRAI_ORCHESTRATOR_GRAPH=0` for a "1", "n",
  "n" answer sequence — correct — and printed nothing past "Saved. Run
  ..." — `main()` was never called, confirmed by no supervisor startup
  output and no processes left running.
- **`--classic` under a real TTY**: forces the plain prompt wizard even
  though stdin is interactive — confirmed by the literal
  "OrchestrAI setup wizard —" banner rendering as plain scrolling text, not
  the full-screen form. Ctrl+C cancelled cleanly with
  "Setup cancelled — nothing was written." and no process left running.
- **`--web`**: rejected immediately with the exact message pointing to
  specs/049, exit code 1, no prompt of any kind.
- **`Ctrl+X` (save-only) via the real form**: typed a real scratch target
  path into the field, pressed Ctrl+X — the write succeeded (confirmed by
  reading the actual `.orchestrai/config.env`/`orchestrai.project.txt`
  written to that target, byte-correct), the process exited cleanly
  (`exitCode: 0`), and no service was launched. The terminal's own final
  "Saved. Run..." line was not reliably captured in the screen-buffer
  snapshot in this pass (a likely alt-screen-transition capture artifact of
  this harness, the same class already flagged for the below-80×24 resize
  case in Phase 2 — the write itself, the thing that actually matters, was
  independently confirmed via the real file on disk, not just the screen).
- **`Ctrl+S` (save-and-start) via the real form, headless** (`init
  --headless`, to isolate this phase's own mechanism from the separate TUI
  auto-launch interaction below): typed a scratch target, deselected one
  agent, pressed Ctrl+S. Full real startup: `mcp:http` (auto-included per
  the existing dependency rule, unchanged), `devops-agent`, `testing-agent`,
  `documentation-agent`, `security-agent`, and `orchestrator` all started as
  real child processes and all reported `✓` in the startup summary — each
  checkmark is a real `waitForHealthy()` HTTP poll against that service's
  own `/healthz`, not a weaker proxy. No crash, no orphaned processes after
  the harness killed the parent (confirmed via `tasklist`/`netstat` showing
  nothing left bound). This is the core deliverable of this spec, live and
  working: choosing "start" in the form genuinely brings up a real backend
  with no second command typed.
- **`Ctrl+S` with the TUI auto-launch enabled** (no `--headless`, matching a
  real interactive terminal's default): the same full startup with all
  services healthy was confirmed once more, but the process then exited
  shortly after printing "Opening terminal viewer..." while attempting to
  create the *second* `CliRenderer` (the TUI's own) in the same process —
  not the silent/undefined crash fixed above (a clean, if unexplained, exit
  this time), and not reproduced at all in headless mode. Not yet
  root-caused or fixed; flagged honestly as a known open item for Phase 5
  rather than assumed benign. specs/016/017's own TUI verification was
  always done in Yusuf's real terminal, never this synthetic PTY harness —
  this may be the same class of harness-specific limitation, or a genuine
  second issue; undetermined either way without a real-terminal test.

### Not yet exercised

- `Ctrl+S` → TUI auto-launch → real keyboard interaction with the TUI
  itself, in a real terminal (blocked on the open item directly above).
- A genuinely fresh `bunx`/`npx orchestrai init` from an empty directory
  with no prior `.orchestrai/` anywhere in its resolution chain.

## Phase 5 — verification and documentation

### Automated gates

`bun test` 695/695, `bun run typecheck` 0 errors, `bun run specs:catalog`/
`specs:check` clean, `bun run build` succeeded (141.0 MB compiled binary,
model already fetched). All of Phase 4's PTY matrix was re-run against the
compiled binary (`dist/bin/orchestrai.exe`) rather than `bun run`, with
identical results: `--help` prints; a non-TTY piped run writes a
byte-correct config from a genuinely fresh scratch directory and starts
nothing; `--web` rejects immediately (exit 1); `init --headless` →
navigate → Ctrl+S brings up a full real 6-service stack (`mcp:http` + 4
agents + `orchestrator`, all `✓` via real `/healthz` polls) with the
correct target path resolved and no orphaned processes after teardown;
Ctrl+X writes a byte-correct config (confirmed via the real file) and
starts nothing, clean exit code 0.

### Blocking-severity finding: the TUI auto-launch crashes the whole stack

Not a headless-mode issue, not reproduced there in any run. With the TUI
auto-launch enabled (`init` with no `--headless` — the default for a real
interactive terminal, matching every other zero-flag invocation's own
behavior), a live PTY run against the compiled binary showed: the full
6-service stack starts and reports all `✓` healthy exactly as above, then
the process — and every child with it, no orphans, confirmed via
`tasklist` at 1.2s intervals — dies within about a second of printing
"Opening terminal viewer...", while attempting to create the *second*
`CliRenderer` (the TUI's own) in the same process. `node-pty` reports
`exitCode`/`signal` both `undefined`, the same signature as Phase 4's
`stdin.pause()` bug, but this is a **different** issue: it reproduces even
with `process.stdin.resume()` already in place and a 500ms settle delay
inserted before the second renderer is created (both tested, neither
helped — the delay was reverted immediately after, never committed).

**Isolated to a minimal, application-free repro**, not guessed at: a
scratch script (never committed) that does nothing but
`createCliRenderer()` → `createRoot().render(<box>...</box>)` → wait →
`root.unmount()` + `destroy()` (awaiting the real `"destroy"` event, same
as `init-form.tsx`'s own fix) → `createCliRenderer()` again →
`createRoot().render(<box>...</box>)` again, with **no** `main()`, no
`chdir`, no spawned children, no form, nothing from this spec's own code —
crashed identically. A narrower version of the same script that created
and destroyed renderer 1 **without ever calling `.render()`** on it (bare
renderer, never actually used) did **not** crash — renderer 2 was created
successfully every time. A separate version that added a real spawned
child process (no rendering difference) between the two renderers also did
**not** crash. This narrows the trigger specifically to: create a
`@opentui/react` root, actually render real content through it, tear it
down, then create and render a second one — in this exact process. This
has never been exercised anywhere else in this codebase before this spec:
every prior use of `CliRenderer` (`apps/tui/index.tsx`, the classic
wizard's masked-key `suspend()`/`resume()` cycle, this spec's own
Phases 2–3) creates and uses **exactly one** renderer for the life of its
process. Spec 048 is the first time a process creates, actually uses, and
destroys **one** `CliRenderer`/React root and then creates a **second**
one afterward.

**Not fixed in this pass, deliberately.** The only line involved
(`await (await import("../tui/index")).start()` in `main()`'s existing
`shouldOpenTui` block) is pre-existing code this spec has not otherwise
touched, and the plan's own Stop Conditions list "changing `main()`'s
startup sequence" as a return-for-review trigger — a real fix here would
mean either changing that startup sequence, or working around what looks
like an upstream `@opentui/react` reconciler-level limitation, neither of
which this phase is authorized to do unilaterally.

**Genuinely unconfirmed either way without a real terminal.** Every single
test in this whole spec — the ones that pass and this one that fails — ran
through `node-pty`'s Windows ConPTY wrapper, the same harness already
flagged (Phase 2) for a capture-fidelity caveat and (throughout this repo's
history, specs/016/017) never treated as a substitute for a real terminal
for anything TUI-rendering-related. This may be a genuine
`@opentui/react` bug that will reproduce in any terminal, or an artifact
of nesting a second native console-mode renderer inside ConPTY's own
already-unusual console emulation (the same family as the already-known
"AttachConsole failed" ConPTY cleanup quirk this harness hits at exit).
**Undetermined without Yusuf's own real-terminal test.**

**Practical impact if this does reproduce in a real terminal**: choosing
"start" in the new form would bring up the real stack and then crash the
entire thing (backend included, no orphans left behind — at least that
part fails safely) within about a second, before the user ever sees the
TUI. `orchestrai init --headless` remains a fully working, fully verified
alternative that never hits this path at all — it starts the stack and
stays running exactly as designed. `orchestrai tui` run as a separate,
second command against the resulting live stack is also unaffected (it's
the *only* renderer in *that* process). Flagging this to Yusuf directly
rather than deciding a mitigation alone: worth a quick real-terminal check
before deciding whether this needs its own follow-up checkpoint, or a
narrower fix (e.g., defaulting the form's own `^S` path to headless until
`@opentui/react` supports this pattern, decided explicitly rather than
silently) is warranted.

### Not yet done

- Yusuf's real-terminal checklist (per the plan): the masked key moment's
  true visual behavior, Ctrl+C at several fields, resize/zoom, and —
  blocked on the finding above — whether `^S` genuinely starts a working
  stack with no second command in a real terminal.
- A genuinely fresh `bunx`/`npx orchestrai init` from an empty directory
  (this pass used a scratch directory created by this session, not a
  clean install from the published package).

## Post-Phase-5 round — Yusuf's real terminal, three real bugs found and fixed

Yusuf ran the compiled binary's `init` in a real terminal per the Phase 5
checklist and found three real, live issues screenshotted directly, none
ever caught by this repo's own PTY harness:

1. **The target-path field wasn't rendering as a real 3-row box.** Content
   was painting on top of its own bottom border ("└─C:\path████──┘" on one
   row) instead of a separate row between two border lines. Fixed with an
   explicit `height` on both the inner bordered box AND its outer label
   wrapper — the inner fix alone left the wrapper under-measuring its own
   total height by exactly one row, which then collided with the scrollbox
   painting immediately after it.
2. **The banner was a plain single text line** — Yusuf asked for something
   bigger/more distinct, pointing at a browser mockup's titled-box
   treatment for reference. Rebuilt as a real bordered box around the
   wordmark. Getting there hit three more real, live-caught bugs:
   `border: true` directly on the true React root overflowed the terminal
   width by a column or two (fixed by nesting the border one level down,
   matching CLAUDE.md's existing "no explicit root width/height"
   constraint); OpenTUI's own border-embedded `title` feature and a second
   subtitle line inside the same box both broke the outer box's left
   padding for every row after them — eventually isolated to an emoji (⚡)
   in the text, confirmed by removing only the emoji and nothing else. The
   shipped design has no emoji, no `title` feature, and exactly one content
   row inside the banner box — the one combination verified clean at both
   100×30 and the true minimum 80×24.
3. Clarified in conversation, not a code change: the difference between
   "LLM planning harness" and "Adaptive planner" in the form (see
   CLAUDE.md's "Opt-in LLM harness (Planning Agent)" and "Adaptive
   supervisor (Orchestrator)" sections) — two independent LLM-gated
   features already documented at length elsewhere in this codebase, not
   specific to this spec.

`bun test` 695/695, `bun run typecheck` 0 errors. Live-verified via the PTY
harness at both 100×30 and 80×24 (the true `MIN_COLS`×`MIN_ROWS`) after each
fix; the compiled binary itself was not yet rebuilt with this round's
changes as of this entry — that's Yusuf's own re-run to confirm.

## Follow-up, 2026-09-06 — the double-`CliRenderer` crash finding above is addressed

The open finding recorded earlier in this document (the second
`CliRenderer` crash on `^S`) is fixed in
`specs/062-guided-init-tui-as-child-process/spec.md` (implemented,
`verification: partial`), which amends this spec rather than reopening
it: the auto-launched TUI is now spawned as its own child process instead
of being imported and called in-process, so a fresh process — with zero
prior renderers — can never hit the upstream limitation. See that spec's
own verification.md for what's confirmed (typecheck, full test suite,
non-TTY/`--headless` path live-unaffected) and what still needs Yusuf's
real terminal (the actual `^S` repro, the existing two-step quit, and a
no-orphan check) before this finding can be called fully closed.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

See specs/049-guided-init-web-setup/verification.md for the relocated narrative covering this checkpoint.
