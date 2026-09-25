/** @jsxImportSource @opentui/react */
// specs/048-guided-init-experience/spec.md — Phase 2.
//
// The full-screen setup form's rendering. Holds no business logic of its
// own — every decision (what's valid, what's visible, what gets written)
// lives in ./init-form-state.ts and is already tested there. This file only
// turns that state into boxes/text and turns keystrokes into state
// transitions.
//
// Layout constraints inherited verbatim from specs/012 and specs/047,
// found live in exactly this codebase, not theoretical:
//   - No explicit root width/height from useTerminalDimensions() — the
//     eleventh-round regression documented in apps/tui/index.tsx.
//   - No flexGrow/flexShrink on a scrollbox — specs/047 Phase 2 found this
//     corrupts rows rendered above it. Any scrollable region here gets an
//     explicit COMPUTED height instead, the same fix that landed there.
//   - Every long value is bounded/truncated, never left to wrap — specs/047
//     Phase 2's second fix; an unbudgeted wrapped row pushes content past
//     the terminal height and corrupts the header via the same
//     cursor-position wraparound apps/tui/index.tsx's own Tasks row-budget
//     comments describe.
//
// Text fields (target path, model) are deliberately NOT OpenTUI <input>
// components. @opentui/core's Textarea/Input keybindings aren't documented
// well enough to be certain Tab wouldn't be consumed by a focused input
// instead of moving to the next field — so, matching this codebase's own
// established technique (the wizard's own masked reader already hand-rolls
// character-by-character input), both are plain <text> showing a manually
// managed buffer plus a cursor glyph when focused. This keeps ALL key
// handling in one place, exactly like apps/tui/index.tsx's own
// useKeyboard/resolveKeyOwner does for the workspace TUI.

import { createCliRenderer, decodePasteBytes, type CliRenderer, type ScrollBoxRenderable } from "@opentui/core"
import { createRoot, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react"
import { normalizePastedText } from "../../packages/shared/paste-text"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { AGENT_CATALOG, skillHint } from "./agent-catalog"
import {
  type FormFieldId,
  type InitFormState,
  type InitOutcome,
  availableProviders,
  canLeaveProvidersStep,
  canOpenRowPicker,
  closeProvidersView,
  cyclePickerProvider,
  cycleRowProvider,
  fieldScrollOffset,
  formStateToWizardConfig,
  initialFormState,
  moveAgentCursor,
  agentLlmFieldsFor,
  enterModelSelectMode,
  exitModelSelectMode,
  keyForProvider,
  modelAtCursor,
  modelListForCursor,
  MODEL_PICKER_WINDOW,
  modelPickerWindow,
  modelsRows,
  moveFocus,
  moveModelsCursor,
  moveModelPickerCursor,
  moveProvidersCursor,
  movePortsCursor,
  openProvidersView,
  pickModelFromList,
  portOverrideAtCursor,
  providerAtProvidersCursor,
  registerProviderKey,
  resolvedHarnessLimit,
  resolvedPort,
  resolvedProviderAtCursor,
  serviceAtPortsCursor,
  setHarnessLimitOverride,
  setModelAtCursor,
  setModelFetchError,
  setModelFetchLoading,
  setModelFetchSuccess,
  setPortOverrideAtCursor,
  setText,
  SERVICE_PORT_ROWS,
  toggleAgentAtCursor,
  unregisterProviderKey,
  validate,
  visibleFields,
} from "./init-form-state"
import { AGENT_LLM_HARNESSES, LLM_PROVIDERS, WizardCancelledError, type LlmProvider, maskKey, promptLine, readExistingWizardConfig, writeWizardConfig } from "./init-wizard"
import type { LlmComponent } from "../../packages/shared/llm-model-factory"
import { DEFAULT_SERVICE_PORTS, type ServicePortName } from "../../packages/shared/service-ports"
import { DEFAULT_HARNESS_RECURSION_LIMIT } from "../../packages/shared/harness-limits"
import { listAvailableModels, type DiscoveredModel } from "./model-discovery"

const MIN_COLS = 80
const MIN_ROWS = 24

function bounded(value: string, max: number): string {
  if (max <= 1) return value.length > 0 ? "…" : ""
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Reported by Yusuf from a real terminal: pressing Enter in a text field
 *  inserted a line break instead of doing anything useful. The old filter
 *  was `sequence.length === 1 && !ctrl && !meta`, and Enter's sequence is
 *  "\r" — one character, no modifier — so it sailed straight through as
 *  typed text, as did Tab ("\t") and Escape. A length check is not a
 *  printability check: control characters are single characters too. */
function isPrintable(sequence: string | undefined): sequence is string {
  if (!sequence || sequence.length !== 1) return false
  const code = sequence.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f
}

export interface InitFormResult {
  // specs/122 — "save-and-start" removed: same-session launch (dispatch()
  // chaining chdir + main() right after this form's own renderer tears
  // down) was a confirmed crash/hang on a real terminal, never a working
  // path. "save" is now the only non-cancel outcome, reachable via Ctrl+X
  // (specs/122 amendment 2026-09-25 removed the Ctrl+S alias).
  action: "save" | "cancel"
  state: InitFormState
}

/** Phase 3 — the one novel mechanism in this spec, and the reason it's
 *  simpler than it first looks: @opentui/core's own `CliRenderer` already
 *  has a purpose-built `suspend()`/`resume()` pair (confirmed by reading
 *  the real implementation, not just the .d.ts — `suspend()` synchronously
 *  removes the renderer's own stdin `data` listener and calls
 *  `stdin.setRawMode(false)`, exactly the two things `promptLine`'s own
 *  raw-mode reader needs to safely take over; `resume()` reverses both).
 *  So this hands off to the EXISTING, unmodified, already-live-verified
 *  masked reader (`promptLine` with `masked:true`) using the renderer's
 *  own designed-for-this mechanism, rather than destroying and recreating
 *  the whole renderer/React root — an earlier version of this function did
 *  exactly that and a live PTY run found it genuinely did not reliably
 *  hand stdin back afterward (the masked prompt never received input).
 *  `suspend()`/`resume()` fixed that; the form's single renderer and React
 *  root live for the form's entire lifetime, never torn down until a
 *  final outcome.
 *
 *  Ctrl+C during entry resolves via WizardCancelledError, caught here and
 *  treated as "nothing changed" — it returns to the form with whatever key
 *  state it already had, never exits `init`, never writes anything. */
async function collectMaskedKeyFromTerminal(renderer: CliRenderer): Promise<string | null> {
  renderer.suspend()
  console.log("\nSecure entry — the form is paused; nothing is written yet.")
  console.log("Paste or type your API key. Input is masked.")
  console.log("Ctrl+C returns to the form without changing it.\n")
  try {
    const value = await promptLine("API key: ", { masked: true })
    return value.trim() || null
  } catch (err) {
    if (err instanceof WizardCancelledError) return null
    throw err
  } finally {
    renderer.resume()
  }
}

/** specs/048-guided-init-experience/spec.md §4 — a real bug found live
 *  during Phase 4's own PTY verification, not assumed away: `destroy()`'s
 *  own real implementation (read directly, not just its `.d.ts`, which
 *  only promises `void`) defers its actual teardown — removing native
 *  resources, running `root.destroyRecursively()`, emitting its own
 *  "destroy" event — to a LATER render-loop tick when `destroy()` is
 *  called while a frame is still rendering; it does not finish
 *  synchronously. Resolving immediately after calling `destroy()` (the
 *  first version of this function did exactly that) let the caller
 *  (dispatch(), which immediately calls the real main() — spawning child
 *  processes, doing real I/O) race that still-pending teardown, producing
 *  an intermittent, silent process crash (no JS exception, no exit code —
 *  consistent with a native-level conflict) that never happened when the
 *  caller did nothing more afterward (the "save" path, whose own
 *  post-destroy work is two console.log calls and a return). Fixed by
 *  genuinely awaiting the renderer's own "destroy" event before resolving. */
async function destroyRendererAndWait(renderer: CliRenderer): Promise<void> {
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
    renderer.destroy()
  })
}

/** Renders the form and resolves once the user picks a final outcome. The
 *  caller (dispatch(), Phase 4) never has to know about OpenTUI, the masked
 *  reader, or the suspend/resume cycle — it just awaits a plain result. */
export async function runInitForm(targetDirDefault: string, existing: { env: Record<string, string>; projectPath?: string }): Promise<InitFormResult> {
  const allAgents = AGENT_CATALOG.map((a) => a.name)
  const initial = initialFormState(targetDirDefault, allAgents, existing)

  const renderer = await createCliRenderer()
  const root = createRoot(renderer)

  return new Promise((resolve) => {
    const finish = (action: InitFormResult["action"], state: InitFormState) => {
      root.unmount()
      destroyRendererAndWait(renderer).then(() => resolve({ action, state }))
    }
    // specs/063 — the Providers screen's masked key entry (specs/070
    // removed the setup screen's own separate API-key row; this is the
    // only masked-reader entry point now). Reuses the exact same
    // suspend/raw-mode reader, applying via registerProviderKey().
    const onRequestProviderKey = async (state: InitFormState, apply: (next: InitFormState) => void) => {
      const key = await collectMaskedKeyFromTerminal(renderer)
      apply(key !== null ? registerProviderKey(state, key) : state)
    }
    root.render(<InitFormApp initial={initial} onResolve={finish} onRequestProviderKey={onRequestProviderKey} />)
  })
}

/** specs/048-guided-init-experience/spec.md §4 (Phase 4) — the form's own
 *  write orchestration, mirroring runInitWizardInner's own confirm/write
 *  ending exactly: reads whatever's already saved for `targetDirDefault` to
 *  pre-fill (the same call the classic wizard makes), runs the form, and on
 *  anything but "cancel" writes via the SAME writeWizardConfig the classic
 *  wizard uses — so a form-written config and a classic-wizard-written
 *  config are byte-identical for the same answers (the Phase 1 "one config
 *  contract" test already proves the underlying
 *  formStateToWizardConfig()/formatConfigEnv() pairing matches; this is
 *  just the write call reusing that same proven path).
 *
 *  specs/122 — always resolves "saved" now, never "started": this form
 *  used to also offer launching the stack in the same process
 *  (dispatch()'s now-removed chdir+main() chain), which never reliably
 *  worked on a real terminal. Ctrl+X reaches this branch. */
export async function runInitFormAndWrite(targetDirDefault: string): Promise<InitOutcome> {
  const existing = readExistingWizardConfig(targetDirDefault)
  const result = await runInitForm(targetDirDefault, existing)
  if (result.action === "cancel") return { outcome: "cancelled" }

  const config = formStateToWizardConfig(result.state)
  writeWizardConfig(config.projectPath, config)

  console.log(`\nSaved. Run "orchestrai" (no flags) from ${config.projectPath} to use this configuration.`)
  return { outcome: "saved", targetPath: config.projectPath }
}

function InitFormApp(props: {
  initial: InitFormState
  onResolve: (action: InitFormResult["action"], state: InitFormState) => void
  onRequestProviderKey: (state: InitFormState, apply: (next: InitFormState) => void) => void
}) {
  const [state, setState] = useState(props.initial)
  const [dirExistsCache, setDirExistsCache] = useState<Record<string, boolean>>({})
  // specs/059-tui-bracketed-paste-support/spec.md Phase 2 — transient,
  // display-only feedback for a rejected (oversized) paste. Deliberately
  // local component state, not part of InitFormState/init-form-state.ts's
  // own separately-tested reducers — the same "local, UI-only" precedent
  // dirExistsCache above already establishes, since this has no bearing
  // on what gets validated or written.
  const [pasteError, setPasteError] = useState<string | null>(null)
  const { width, height } = useTerminalDimensions()
  const fieldsScrollRef = useRef<ScrollBoxRenderable | null>(null)

  // The renderer has no access to `fs` concerns here on purpose — the real
  // existsSync check is injected by the caller via a global set once at
  // start(), keeping this component importable/testable without touching a
  // real filesystem. See start() below.
  const dirExists = (p: string) => dirExistsCache[p] ?? initGlobals.dirExists(p)

  const validation = validate(state, dirExists)

  // specs/125-configurable-harness-recursion-limit/spec.md — live-caught
  // during that spec's own PTY verification: typing an invalid value into
  // the LAST field (Harness limit, or Ports before it) computed a real
  // validation error, but the error line never appeared on screen. Root
  // cause confirmed by inspecting the raw captured buffer: the scrollbox
  // clamps its actual scrollable range to its OWN real (Yoga-measured)
  // content height, which fieldScrollOffset()'s hand-rolled row count does
  // not track — when an error line appears, real content grows by one row
  // but the requested scroll target (below) does not, so the clamped
  // viewport's bottom edge lands exactly one row short. Every field's own
  // error renders as exactly one line (see PortsSection/HarnessLimitRow/
  // ModelsSection, all `{props.error ? <text>...` single lines), so
  // requesting one extra row of scroll whenever the focused field
  // currently has an error is sufficient — confirmed empirically by
  // re-running the same PTY capture after this fix.
  const focusHasError = Boolean(validation.errors[state.focus])

  // Keeps the focused field visible as Tab/arrows move through fields the
  // scrollbox has scrolled out of view — found necessary the same way the
  // scrollbox switch itself was: without it, Tab could move focus onto a
  // field the user couldn't see or get back to without knowing to scroll
  // manually. One row per line, matching a plain terminal row's own height.
  useEffect(() => {
    const scroll = fieldsScrollRef.current
    if (!scroll) return
    // specs/073 — the Models section's own real (unfocused) row count is
    // passed explicitly so a later field (Ports) scrolls to the right
    // place regardless of how many LLM agents are selected.
    const offset = fieldScrollOffset(state.focus, state.allAgents.length, visibleFields(state), 1 + modelsRows(state).length)
    // specs/125 — +1 when the focused field has a validation error, so its
    // one-line error is included in the scrolled-to viewport rather than
    // clipped by the scrollbox's own real content-height clamp.
    scroll.scrollTo(focusHasError ? offset + 1 : offset)
    // specs/070 — the field list is static now (Target → Agents → Model),
    // but the agent-section height still varies with the roster length, so
    // keep the selection in the dep list. specs/125 — focusHasError added
    // so a validation error appearing/clearing on the already-focused
    // field re-triggers the scroll without requiring a focus change.
  }, [state.focus, state.allAgents.length, state.selectedAgents, focusHasError])

  // specs/063-init-per-component-provider-and-key/spec.md — live model
  // discovery. Fires whenever the Models-screen cursor lands on a
  // component row whose resolved provider hasn't been fetched (or is
  // mid-fetch/errored) yet this session — never re-fetches a provider
  // already successfully listed, matching this spec's own "keyed by
  // provider so a provider already fetched isn't re-fetched" design.
  // Bounded and never-throwing by construction: listAvailableModels()
  // itself already resolves every failure to {ok:false, error} rather
  // than rejecting (see model-discovery.ts), so there is no unhandled
  // rejection here even on a network failure or invalid key.
  useEffect(() => {
    // specs/071 — the Models section replaces the standalone Models view;
    // this fetches for whichever row `state.modelsCursor` currently
    // highlights (resolvedProviderAtCursor() reads it via modelsRows()),
    // never on the Providers screen. Never re-fetches a provider already
    // successfully listed this session.
    if (state.view !== "setup") return
    const provider = resolvedProviderAtCursor(state)
    const status = state.modelFetchStatus[provider]
    if (status === "loading" || state.discoveredModels[provider]) return
    const key = keyForProvider(state, provider)
    if (!key) return
    let cancelled = false
    setState((s) => setModelFetchLoading(s, provider))
    listAvailableModels(provider, key).then((result) => {
      if (cancelled) return
      setState((s) => (result.ok ? setModelFetchSuccess(s, provider, result.models) : setModelFetchError(s, provider, result.error)))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state itself
    // is read fresh via the functional setState updates above; including
    // the whole object here would re-fire on every unrelated keystroke.
  }, [state.view, state.modelsCursor, state.selectedAgents, state.providerOverrides, state.llmProvider, state.extraProviders, state.llmApiKey])

  useKeyboard((key) => {
    // specs/059 — a real keystroke supersedes a stale paste-rejection
    // notice from an earlier attempt.
    if (pasteError) setPasteError(null)

    // Global actions first — always reachable, matching the footer's own
    // stated key hints. ^X works from the Models view too; only Esc
    // differs there, and the Models branch below claims it first.
    //
    // specs/122 (amended 2026-09-25) — Ctrl+X is the only save key. Ctrl+S once launched the
    // stack in-process (removed by specs/122 as a confirmed crash/hang),
    // then was kept as a save alias; it is now unbound.
    if (key.ctrl && key.name === "x") {
      if (validation.canSave) props.onResolve("save", state)
      return
    }

    // specs/071 — a Models-row picker owns every key while it is open,
    // ahead of Esc/p/Tab/the rest of the setup screen's own handling —
    // the exact precedence the retired Models view's own picker block
    // had. Esc here means "type it in instead" (exit select mode), never
    // "cancel the form" — that would lose the user's place surprisingly.
    // Ctrl+C still cancels, matching every other screen.
    if (state.focus === "models" && state.modelPickerOpen) {
      if (key.ctrl && key.name === "c") { props.onResolve("cancel", state); return }
      if (key.name === "escape") { setState((s) => exitModelSelectMode(s)); return }
      if (key.name === "up") { setState((s) => moveModelPickerCursor(s, -1)); return }
      if (key.name === "down") { setState((s) => moveModelPickerCursor(s, 1)); return }
      if (key.name === "return") { setState((s) => pickModelFromList(s)); return }
      // specs/071 §4 — plain arrows cycle the row's own provider override
      // while the picker is open (picker mode is never text entry, so
      // there is no in-string cursor here to steal); the model list below
      // re-resolves to the newly selected provider. A no-op on the
      // "shared" row or with <2 providers registered, via
      // cyclePickerProvider()'s own contract.
      if (key.name === "left") { setState((s) => cyclePickerProvider(s, -1)); return }
      if (key.name === "right") { setState((s) => cyclePickerProvider(s, 1)); return }
      // Tab leaves the picker and moves to the next/prev Models row
      // rather than trapping focus inside the list.
      if (key.name === "tab") { setState((s) => moveModelsCursor(exitModelSelectMode(s), key.shift ? -1 : 1)); return }
      return
    }

    // specs/063-init-per-component-provider-and-key/spec.md — the
    // Providers screen, same shape as the Models block above: it owns
    // every key while open, Esc goes back to setup (never a cancel),
    // Ctrl+C still cancels.
    if (state.view === "providers") {
      if (key.ctrl && key.name === "c") { props.onResolve("cancel", state); return }
      // specs/068 — Providers is step 1. Esc and Tab-past-the-last-row are
      // both "continue to agent selection"; closeProvidersView() is gated
      // (a no-op until at least one credential is registered), and the
      // ProvidersView renders the "register at least one" hint while it is.
      if (key.name === "escape") { setState((s) => closeProvidersView(s)); return }
      if (key.name === "up") { setState((s) => moveProvidersCursor(s, -1)); return }
      if (key.name === "down") { setState((s) => moveProvidersCursor(s, 1)); return }
      if (key.name === "tab") {
        if (!key.shift && state.providersCursor === LLM_PROVIDERS.length - 1) {
          setState((s) => closeProvidersView(s))
          return
        }
        setState((s) => moveProvidersCursor(s, key.shift ? -1 : 1))
        return
      }
      if (key.name === "return") {
        props.onRequestProviderKey(state, setState)
        return
      }
      // Unregisters the focused (non-shared) provider — a no-op on the
      // shared row itself, matching unregisterProviderKey()'s own
      // contract, so there is no separate guard needed here.
      if (key.name === "backspace" || key.name === "delete") {
        setState((s) => unregisterProviderKey(s))
        return
      }
      return
    }

    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      props.onResolve("cancel", state)
      return
    }

    // specs/063 — open the Providers screen. Not while a text field has
    // focus, where "p" is a character being typed, not a command.
    // specs/071 — the `m` keybinding (and the standalone Models view it
    // opened) is retired: the Models section now lives on this screen.
    if (key.name === "p" && !key.ctrl && !key.meta && state.focus !== "targetPath" && state.focus !== "models" && state.focus !== "ports" && state.focus !== "harnessLimit") {
      setState((s) => openProvidersView(s))
      return
    }

    if (key.name === "tab") {
      setState((s) => moveFocus(s, key.shift ? -1 : 1))
      return
    }

    // Field-specific handling.
    if (state.focus === "agents") {
      if (key.name === "up") { setState((s) => moveAgentCursor(s, -1)); return }
      if (key.name === "down") { setState((s) => moveAgentCursor(s, 1)); return }
      if (key.name === "space" || key.name === "return") { setState((s) => toggleAgentAtCursor(s)); return }
      return
    }

    if (state.focus === "targetPath") {
      if (key.name === "backspace") { setState((s) => setText(s, "targetPath", s.targetPath.slice(0, -1))); return }
      if (key.name === "return") { setState((s) => moveFocus(s, 1)); return }
      if (isPrintable(key.sequence) && !key.ctrl && !key.meta) {
        setState((s) => setText(s, "targetPath", s.targetPath + key.sequence))
      }
      return
    }

    // specs/071 — the Models section (folded in from the retired `m`
    // view, specs/050/063/068): ↑/↓ move the row cursor; Enter opens the
    // picker (handled above, ahead of this block, once it's open) when
    // there's a choice — canOpenRowPicker() covers both "a real model
    // list exists" and "a second registered provider to switch to" —
    // otherwise it moves to the next row. Ctrl+←/→ still cycles a
    // component row's own provider override directly, a power-user
    // shortcut alongside the open picker's own plain-arrow path.
    if (state.focus === "models") {
      if (key.name === "up") { setState((s) => moveModelsCursor(s, -1)); return }
      if (key.name === "down") { setState((s) => moveModelsCursor(s, 1)); return }
      // specs/132 — plain or Ctrl ←/→ switches the row's provider: the
      // shared row cycles the default provider, a component row its own
      // override. The row is free text, but there's no in-string cursor
      // to move, so arrows were otherwise unused here.
      if (key.name === "left" || key.name === "right") {
        setState((s) => cycleRowProvider(s, key.name === "left" ? -1 : 1))
        return
      }
      if (key.name === "backspace") {
        setState((s) => setModelAtCursor(s, modelAtCursor(s).slice(0, -1)))
        return
      }
      if (key.name === "return") {
        setState((s) => (canOpenRowPicker(s) ? enterModelSelectMode(s) : moveModelsCursor(s, 1)))
        return
      }
      if (isPrintable(key.sequence) && !key.ctrl && !key.meta) {
        setState((s) => setModelAtCursor(s, modelAtCursor(s) + key.sequence))
      }
      return
    }

    // specs/073-configurable-service-ports/spec.md — the Ports section:
    // ↑/↓ move the row cursor, Enter moves to the next row (there's no
    // picker to open here, unlike Models), backspace/digits edit the
    // focused row's override. Only digits are accepted — a port is
    // always a number, so anything else typed is silently ignored rather
    // than accepted and rejected later by validate().
    if (state.focus === "ports") {
      if (key.name === "up") { setState((s) => movePortsCursor(s, -1)); return }
      if (key.name === "down") { setState((s) => movePortsCursor(s, 1)); return }
      if (key.name === "return") { setState((s) => movePortsCursor(s, 1)); return }
      if (key.name === "backspace") {
        setState((s) => setPortOverrideAtCursor(s, portOverrideAtCursor(s).slice(0, -1)))
        return
      }
      if (isPrintable(key.sequence) && !key.ctrl && !key.meta && /^[0-9]$/.test(key.sequence)) {
        setState((s) => setPortOverrideAtCursor(s, portOverrideAtCursor(s) + key.sequence))
      }
      return
    }

    // specs/125-configurable-harness-recursion-limit/spec.md — the
    // harness-limit field: a single row, so there's no cursor to move —
    // Enter just advances focus, same as targetPath's own Enter. Digits
    // only, same reasoning as Ports (a bound is always a whole number).
    if (state.focus === "harnessLimit") {
      if (key.name === "return") { setState((s) => moveFocus(s, 1)); return }
      if (key.name === "backspace") {
        setState((s) => setHarnessLimitOverride(s, s.harnessLimitOverride.slice(0, -1)))
        return
      }
      if (isPrintable(key.sequence) && !key.ctrl && !key.meta && /^[0-9]$/.test(key.sequence)) {
        setState((s) => setHarnessLimitOverride(s, s.harnessLimitOverride + key.sequence))
      }
      return
    }
  })

  // specs/059-tui-bracketed-paste-support/spec.md Phase 2 — the two
  // hand-rolled, append-at-end text fields this form owns (target path,
  // and each Models-section row's model, specs/071). usePaste() is real
  // and confirmed working live under a real PTY (this spec's own Phase 1
  // finding) — it fires independently of useKeyboard() above, so
  // registering both causes no interference. Every in-scope field here
  // is single-line, matching @opentui/core's own built-in <input> paste
  // behavior (never the masked API-key reader, which runs during
  // renderer.suspend() with no live React tree mounted — that surface's
  // own paste handling lives in promptLine() in init-wizard.ts instead,
  // not here).
  usePaste((event) => {
    const decoded = decodePasteBytes(event.bytes)
    const normalized = normalizePastedText(decoded, { singleLine: true })
    if (!normalized.ok) {
      // Visible, explicit rejection — never a silent truncation. Cleared
      // on the next keystroke/paste/field change below.
      setPasteError(normalized.error)
      return
    }
    setPasteError(null)

    if (state.focus === "models" && !state.modelPickerOpen) {
      setState((s) => setModelAtCursor(s, modelAtCursor(s) + normalized.text))
      return
    }
    if (state.focus === "targetPath") {
      setState((s) => setText(s, "targetPath", s.targetPath + normalized.text))
      return
    }
    // specs/073 — a pasted port keeps only its digits; a wrapped copy like
    // "3002\n" or "port: 3002" still lands as a usable value instead of
    // being silently rejected by validate() later.
    if (state.focus === "ports") {
      const digits = normalized.text.replace(/[^0-9]/g, "")
      if (digits) setState((s) => setPortOverrideAtCursor(s, portOverrideAtCursor(s) + digits))
    }
    // specs/125-configurable-harness-recursion-limit/spec.md — same
    // digits-only extraction as Ports, for the same reason (a pasted
    // "40" or "limit: 40" still lands as a usable value).
    if (state.focus === "harnessLimit") {
      const digits = normalized.text.replace(/[^0-9]/g, "")
      if (digits) setState((s) => setHarnessLimitOverride(s, s.harnessLimitOverride + digits))
    }
  })

  if (width < MIN_COLS || height < MIN_ROWS) {
    return (
      <box style={{ flexDirection: "column", padding: 1 }}>
        <text style={{ fg: "#f85149" }}>Terminal too small for OrchestrAI Setup.</text>
        <text> </text>
        <text>Current:  {width}×{height}</text>
        <text>Required: {MIN_COLS}×{MIN_ROWS} or larger</text>
        <text> </text>
        <text style={{ fg: "#8b949e" }}>Resize the terminal, or run "orchestrai init --classic" instead.</text>
      </box>
    )
  }

  // specs/063-init-per-component-provider-and-key/spec.md — same
  // early-return pattern as the Models view above, for the same reason:
  // this costs the setup form's own row budget nothing while it's shown.
  if (state.view === "providers") {
    return <ProvidersView state={state} width={width} />
  }

  // Everything between the always-visible header (banner + target field) and
  // the always-visible footer (review + warning) scrolls. Height is
  // COMPUTED and passed to a real <scrollbox>, never flexGrow, and never a
  // plain box relying on overflow:"hidden" to clip — a live PTY run during
  // Phase 2 found overflow:"hidden" alone does NOT clip cleanly here: rows
  // past the box's own height rendered on TOP of earlier rows instead of
  // being cut, corrupting the agent list. A <scrollbox> with an explicit
  // height is the exact mechanism specs/047 Phase 2 already proved safe for
  // this same class of problem (the Chat transcript).
  //
  // Row counts below are exact, not estimated — every line the JSX below
  // actually emits, counted once and kept next to the JSX so a future edit
  // has to touch both. A second, real PTY run confirmed this count against
  // the live rendered screen at 80x24 before it was trusted.
  // The banner is a real bordered box around just the wordmark (bigger,
  // more distinct than the old single plain text line, per Yusuf's own
  // live-terminal feedback), 3 rows: border-top(1) + wordmark(1) +
  // border-bottom(1). Multiple real layout bugs found live in a real
  // terminal along the way, none ever caught by this repo's PTY harness —
  // this is the narrowest combination confirmed to render cleanly:
  //   1. `border: true` directly on THIS outermost box (the true React
  //      root — nothing wraps it) rendered ~1-2 columns wider than the
  //      terminal, spilling a stray "│" down the right edge — the same root
  //      cause CLAUDE.md's "no explicit root width/height" constraint
  //      documents (apps/tui/index.tsx's eleventh-round regression). Fixed
  //      by keeping THIS box exactly as it always was (no border) and
  //      nesting the bordered banner one level down instead — a real child
  //      Yoga sizes against its already-correctly-filled parent, not the
  //      raw terminal, so the identical `border: true` doesn't overflow.
  //   2. An emoji (⚡) inside the nested banner box's own text broke THIS
  //      outer box's left padding for every row rendered after it —
  //      confirmed directly: removing only the emoji (same box, same
  //      border, same everything else) restored correct padding
  //      everywhere. Every other variant tried (OpenTUI's own
  //      border-embedded `title` feature; a second subtitle line inside the
  //      banner box) happened to still contain that same emoji each time,
  //      so those aren't independently ruled out as contributing causes —
  //      only the emoji itself is confirmed. Not something to chase further
  //      from this side of the library; the fix is simply not putting an
  //      emoji inside a nested bordered box here. No emoji, no `title`
  //      feature, exactly one content row — this exact combination is the
  //      one live-verified clean.
  const CHROME_ABOVE = 11 // banner box(3) + subtitle(1) + blank(1) + hint(1) + blank(1) + target label(1) + target box(3)
  const CHROME_BELOW = 3 // blank(1) + review-or-warning(1) + pad-bottom(1)
  const fieldsHeight = Math.max(6, height - CHROME_ABOVE - CHROME_BELOW)

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <box style={{ border: true, borderColor: "#58a6ff", flexDirection: "column", height: 3 }}>
        <text style={{ fg: "#58a6ff" }}>
          Orchestr<span style={{ fg: "#d29922" }}>AI</span> — Setup
        </text>
      </box>
      <text style={{ fg: "#8b949e" }}>local multi-agent orchestration for your SDLC</text>
      <text> </text>
      <text style={{ fg: "#8b949e" }}>
        {bounded("Tab move · Space toggle agent · Enter pick provider + model · p providers · ^X save", Math.max(20, width - 2))}
      </text>
      <text> </text>

      <FieldRow label="Target project" active={state.focus === "targetPath"} error={state.focus === "targetPath" ? (pasteError ?? validation.errors.targetPath) : validation.errors.targetPath}>
        <text style={{ fg: state.focus === "targetPath" ? "#58a6ff" : "#c9d1d9" }}>
          {bounded(state.targetPath, Math.max(10, width - 8))}
          {state.focus === "targetPath" ? <span style={{ fg: "#58a6ff" }}>█</span> : null}
        </text>
      </FieldRow>

      <scrollbox ref={fieldsScrollRef} scrollY={true} contentOptions={{ flexDirection: "column" }} style={{ height: fieldsHeight }}>
        <AgentsSection state={state} active={state.focus === "agents"} width={width} />
        <text> </text>
        {/* specs/070 — no per-agent LLM toggles and no Provider / API-key
            rows: selecting an agent IS the "run its LLM path" decision, and
            provider + key were registered on the Providers step (specs/068).
            specs/071 — the per-agent model + provider picker that used to
            live behind a separate `m` view is this Models section instead. */}
        <ModelsSection
          state={state}
          active={state.focus === "models"}
          width={width}
          error={state.focus === "models" ? (pasteError ?? validation.errors.models) : validation.errors.models}
        />
        <text> </text>
        {/* specs/073 — one row per service's own bind port, defaulting to
            today's hardcoded values; empty means "use the default". */}
        <PortsSection
          state={state}
          active={state.focus === "ports"}
          width={width}
          error={state.focus === "ports" ? (pasteError ?? validation.errors.ports) : validation.errors.ports}
        />
        <text> </text>
        {/* specs/125-configurable-harness-recursion-limit/spec.md — one
            shared row: the ORCHESTRAI_HARNESS_RECURSION_LIMIT override for
            all five agent LLM harnesses' tool-call bound, defaulting to 40. */}
        <HarnessLimitRow
          state={state}
          active={state.focus === "harnessLimit"}
          width={width}
          error={state.focus === "harnessLimit" ? (pasteError ?? validation.errors.harnessLimit) : validation.errors.harnessLimit}
        />
      </scrollbox>

      <text> </text>
      {state.llmApiKey ? (
        <text style={{ fg: "#d29922" }}>⚠ The API key will be stored in plaintext in .orchestrai/config.env</text>
      ) : (
        <ReviewLine state={state} width={width} />
      )}
    </box>
  )
}

function FieldRow(props: { label: string; active: boolean; error?: string; inline?: boolean; children: ReactNode }) {
  const marker = props.active ? "▸" : " "
  if (props.inline) {
    return (
      <text>
        <span style={{ fg: props.active ? "#58a6ff" : "#8b949e" }}>{marker} {props.label.padEnd(16)}</span>
        {" "}
        {props.children}
        {props.error ? <span style={{ fg: "#f85149" }}>  {props.error}</span> : null}
      </text>
    )
  }
  // Two real bugs found live in a real terminal, not this repo's PTY
  // harness (which never caught either): (1) with no explicit height, the
  // inner box painted its content ON its own bottom border instead of a
  // separate row — "└─C:\path████──┘" on one line, not a real 3-row box.
  // (2) fixing that alone (explicit height on the inner box only) still
  // left the wrapping column box — label + inner box, no explicit height of
  // its own — under-measuring its own total height by exactly the same 1
  // row: whatever rendered immediately after (the scrollbox) started 1 row
  // too early and painted over this box's own bottom border. An explicit
  // height on the OUTER wrapper too (label(1) + inner box(3) = 4), not just
  // the inner one, is what actually reserves the real space.
  return (
    <box style={{ flexDirection: "column", height: 4 }}>
      <text style={{ fg: props.active ? "#58a6ff" : "#8b949e" }}>{marker} {props.label}</text>
      <box style={{ border: true, height: 3, paddingX: 1, borderColor: props.error ? "#f85149" : props.active ? "#58a6ff" : "#30363d" }}>
        {props.children}
      </box>
      {props.error ? <text style={{ fg: "#f85149" }}>  {props.error}</text> : null}
    </box>
  )
}

/** specs/071 — a Models-section row's hint: loading / error /
 *  "N models — Enter to pick" / a nudge to register that provider's key.
 *  One function now serves the `"shared"` row and every component row
 *  alike (it used to be `setupModelHint()` here plus a second,
 *  near-identical `discoveryHint()` closure inside the retired
 *  `ModelsView`). */
function modelRowHint(state: InitFormState, provider: LlmProvider, width: number): ReactNode {
  const status = state.modelFetchStatus[provider]
  if (status === "loading") return <text style={{ fg: "#8b949e" }}>{`    fetching ${provider}'s available models…`}</text>
  if (status === "error") {
    return <text style={{ fg: "#f85149" }}>{bounded(`    couldn't list models: ${state.modelFetchError[provider] ?? "unknown error"} — type one manually`, Math.max(20, width - 4))}</text>
  }
  const models = state.discoveredModels[provider]
  if (models && models.length > 0) {
    return <text style={{ fg: "#3fb950" }}>{`    ${models.length} models available — Enter to pick from the list, or type one`}</text>
  }
  if (!keyForProvider(state, provider)) {
    return <text style={{ fg: "#8b949e" }}>{`    register ${provider}'s key on the Providers screen (p) to load its models`}</text>
  }
  return null
}

/** specs/071 §4 — the picker's inline provider line, shown whenever a
 *  second provider is registered (specs/132 extended it to the "shared"
 *  row, whose ←/→ now switches the default provider).
 *  Plain ←/→ cycles it, handled in the keyboard block above via
 *  cyclePickerProvider(); this just renders the current state of that
 *  cycle, one bounded line, inside the picker's own fixed region. */
function ProviderPickerLine(props: { state: InitFormState; provider: LlmProvider; width: number }) {
  const others = availableProviders(props.state).filter((p) => p !== props.provider)
  return (
    <text style={{ fg: "#8b949e" }}>
      {bounded(`    provider: ‹ ${props.provider} ›   ${others.join(" · ")} also registered`, Math.max(20, props.width - 4))}
    </text>
  )
}

function AgentsSection(props: { state: InitFormState; active: boolean; width: number }) {
  // specs/072 — a checkbox plainly shows what's ticked; there is no
  // "secretly all" fallback for an empty selection any more (that was a
  // same-day fix for the OLD "empty means all" convention specs/072
  // deliberately reverses — unticking every box now genuinely means "no
  // agents", so showing every box unticked is the honest rendering).
  return (
    <box style={{ flexDirection: "column" }}>
      <text style={{ fg: props.active ? "#58a6ff" : "#8b949e" }}>
        {props.active ? "▸" : " "} Agents{"  "}
        <span style={{ fg: "#6e7681" }}>↑↓ move · space toggle</span>
      </text>
      {AGENT_CATALOG.map((agent, i) => {
        const selected = props.state.selectedAgents.includes(agent.name)
        const cursor = props.active && props.state.agentCursor === i
        return (
          <text key={agent.name} style={{ bg: cursor ? "#21262d" : undefined }}>
            {cursor ? "▸ " : "  "}
            <span style={{ fg: selected ? "#3fb950" : "#6e7681" }}>{selected ? "[x]" : "[ ]"}</span>
            {" "}
            <span style={{ fg: selected ? "#c9d1d9" : "#8b949e" }}>{agent.name.padEnd(20)}</span>
            <span style={{ fg: "#6e7681" }}>{bounded(skillHint(agent.name), Math.max(10, props.width - 32))}</span>
          </text>
        )
      })}
      <text style={{ fg: "#6e7681" }}>  orchestrator and mcp:http are always included.</text>
    </box>
  )
}

/** specs/071 — the setup screen's own Models section, replacing the
 *  retired standalone Models view (`specs/050`/`063`/`068`). One row for
 *  `"shared / default"` plus one per `modelsRows()` component — the two
 *  always-on components (`orchestrator`, `conversation`;
 *  specs/095-init-models-section-orchestrator-conversation-rows/spec.md)
 *  and every selected agent that has an LLM harness. A row not in edit
 *  focus shows its own resolved
 *  provider + model or "(shared)"; the highlighted row additionally shows
 *  either the live-fetched-model hint or, when open, the picker —
 *  `specs/068`'s arrow-selectable list, now with the `specs/071` §4
 *  inline provider line on a component row with a second provider
 *  registered. */
function ModelsSection(props: { state: InitFormState; active: boolean; width: number; error?: string }) {
  const s = props.state
  const rows = modelsRows(s)
  const labelWidth = 22
  const valueWidth = Math.max(10, props.width - labelWidth - 6)

  function labelFor(row: "shared" | LlmComponent): string {
    if (row === "shared") return "shared / default"
    return AGENT_LLM_HARNESSES.find((h) => h.component === row)?.agent ?? row
  }

  // specs/132 — with two or more providers registered, say how to switch.
  const multiProvider = availableProviders(s).length > 1
  const hint = multiProvider ? "↑↓ move · ←/→ switch provider · Enter pick model" : "↑↓ move · Enter pick provider + model"

  return (
    <box style={{ flexDirection: "column" }}>
      <text style={{ fg: props.active ? "#58a6ff" : "#8b949e" }}>
        {props.active ? "▸" : " "} Models{"  "}
        <span style={{ fg: "#6e7681" }}>{hint}</span>
      </text>
      {rows.map((row, i) => {
        const cursor = props.active && s.modelsCursor === i
        const value = row === "shared" ? s.llmModel : s.modelOverrides[row]
        const provider = row === "shared" ? s.llmProvider : (s.providerOverrides[row] ?? s.llmProvider)
        // specs/132 — every row names the provider it resolves to.
        const followsShared = row !== "shared" && !s.providerOverrides[row] && !value
        const shown = followsShared
          ? `(shared → ${s.llmProvider})`
          : `${provider} · ${value || (row === "shared" ? "(pick from the list or type one)" : "(no model yet)")}`
        return (
          <box key={row} style={{ flexDirection: "column" }}>
            <text style={{ bg: cursor ? "#21262d" : undefined }}>
              <span style={{ fg: cursor ? "#58a6ff" : "#8b949e" }}>{cursor ? "▸ " : "  "}{bounded(labelFor(row), labelWidth - 2).padEnd(labelWidth)}</span>
              <span style={{ fg: value ? "#c9d1d9" : "#6e7681" }}>{bounded(shown, valueWidth)}</span>
              {cursor && !s.modelPickerOpen ? <span style={{ fg: "#58a6ff" }}>█</span> : null}
            </text>
            {cursor ? (
              s.modelPickerOpen ? (
                <box style={{ flexDirection: "column" }}>
                  {multiProvider ? <ProviderPickerLine state={s} provider={provider} width={props.width} /> : null}
                  <ModelPicker models={modelListForCursor(s)} cursor={s.modelPickerCursor} width={props.width} />
                </box>
              ) : (
                modelRowHint(s, provider, props.width)
              )
            ) : null}
          </box>
        )
      })}
      {props.error ? <text style={{ fg: "#f85149" }}>  {props.error}</text> : null}
    </box>
  )
}

/** specs/068 — the arrow-selectable model list. Rendered as its own
 *  lines directly under the focused Models-screen row, inside that
 *  view's existing fixed region (never a wrapped or unbounded line —
 *  the specs/047 constraint this whole file is built around). A list
 *  longer than MODEL_PICKER_WINDOW pages under the sub-cursor via the
 *  pure modelPickerWindow() math; every id is bounded to the terminal
 *  width. */
function ModelPicker(props: { models: DiscoveredModel[]; cursor: number; width: number }) {
  const { start, end } = modelPickerWindow(props.models.length, props.cursor, MODEL_PICKER_WINDOW)
  const shown = props.models.slice(start, end)
  const idWidth = Math.max(10, props.width - 10)
  return (
    <box style={{ flexDirection: "column" }}>
      {shown.map((m, i) => {
        const idx = start + i
        const on = idx === props.cursor
        return (
          <text key={m.id} style={{ bg: on ? "#1f6feb" : undefined }}>
            <span style={{ fg: on ? "#ffffff" : "#c9d1d9" }}>    {on ? "▸" : " "} {bounded(m.id, idWidth)}</span>
          </text>
        )
      })}
      {props.models.length > MODEL_PICKER_WINDOW ? (
        <text style={{ fg: "#6e7681" }}>    {start + 1}–{end} of {props.models.length}</text>
      ) : null}
    </box>
  )
}

/** specs/073-configurable-service-ports/spec.md — display label for each
 *  service's Ports row, matching this codebase's own naming elsewhere
 *  (the `-agent` suffix, `mcp:http`'s own colon form). */
const PORT_ROW_LABELS: Record<ServicePortName, string> = {
  orchestrator: "orchestrator",
  devops: "devops-agent",
  testing: "testing-agent",
  documentation: "documentation-agent",
  security: "security-agent",
  mcpHttp: "mcp:http",
  // specs/082-code-review-agent/spec.md
  codeReview: "code-review-agent",
  // specs/083-coder-agent/spec.md
  coder: "coder-agent",
}

/** specs/073-configurable-service-ports/spec.md — one row per service,
 *  always all of them (8 as of specs/083) regardless of the agent
 *  selection (a port matters even
 *  for a service not currently chosen to start). A row shows its typed
 *  override, or the resolved default when unedited; an out-of-range
 *  value or a collision with another row surfaces as `error` below the
 *  section, same shape every other field's error uses. */
function PortsSection(props: { state: InitFormState; active: boolean; width: number; error?: string }) {
  const s = props.state
  const labelWidth = 22
  const valueWidth = Math.max(10, props.width - labelWidth - 6)
  return (
    <box style={{ flexDirection: "column" }}>
      <text style={{ fg: props.active ? "#58a6ff" : "#8b949e" }}>
        {props.active ? "▸" : " "} Ports{"  "}
        <span style={{ fg: "#6e7681" }}>↑↓ move · type to override, backspace to clear</span>
      </text>
      {SERVICE_PORT_ROWS.map((service, i) => {
        const cursor = props.active && s.portsCursor === i
        const override = s.portOverrides[service] ?? ""
        const resolved = resolvedPort(s, service)
        const display = override ? override : `(default: ${DEFAULT_SERVICE_PORTS[service]})`
        const invalid = override !== "" && resolved === null
        return (
          <text key={service} style={{ bg: cursor ? "#21262d" : undefined }}>
            <span style={{ fg: cursor ? "#58a6ff" : "#8b949e" }}>{cursor ? "▸ " : "  "}{bounded(PORT_ROW_LABELS[service], labelWidth - 2).padEnd(labelWidth)}</span>
            <span style={{ fg: invalid ? "#f85149" : override ? "#c9d1d9" : "#6e7681" }}>{bounded(display, valueWidth)}</span>
            {cursor ? <span style={{ fg: "#58a6ff" }}>█</span> : null}
          </text>
        )
      })}
      {props.error ? <text style={{ fg: "#f85149" }}>  {bounded(props.error, Math.max(20, props.width - 4))}</text> : null}
    </box>
  )
}

/** specs/125-configurable-harness-recursion-limit/spec.md — a single row:
 *  the shared ORCHESTRAI_HARNESS_RECURSION_LIMIT override applied to all
 *  five agent LLM harnesses' tool-call bound. Unlike Ports, there's only
 *  one value here (no per-service list), so this is exactly one row —
 *  marker + label + value on one line, the same shape one Ports row
 *  uses — rather than a section with its own header line. This is
 *  load-bearing: fieldScrollOffset()'s generic "1 row" fallback for any
 *  field after "ports" assumes exactly this shape. */
function HarnessLimitRow(props: { state: InitFormState; active: boolean; width: number; error?: string }) {
  const s = props.state
  const override = s.harnessLimitOverride
  const resolved = resolvedHarnessLimit(s)
  const labelWidth = 22
  const valueWidth = Math.max(10, props.width - labelWidth - 6)
  const display = override ? override : `(default: ${DEFAULT_HARNESS_RECURSION_LIMIT})`
  const invalid = override !== "" && resolved === null
  return (
    <box style={{ flexDirection: "column" }}>
      <text style={{ bg: props.active ? "#21262d" : undefined }}>
        <span style={{ fg: props.active ? "#58a6ff" : "#8b949e" }}>{props.active ? "▸ " : "  "}{bounded("Harness limit", labelWidth - 2).padEnd(labelWidth)}</span>
        <span style={{ fg: invalid ? "#f85149" : override ? "#c9d1d9" : "#6e7681" }}>{bounded(display, valueWidth)}</span>
        {props.active ? <span style={{ fg: "#58a6ff" }}>█</span> : null}
      </text>
      {props.error ? <text style={{ fg: "#f85149" }}>  {bounded(props.error, Math.max(20, props.width - 4))}</text> : null}
    </box>
  )
}

/** specs/063-init-per-component-provider-and-key/spec.md — register a
 *  key per provider before assigning any of them to a component. One
 *  row per LLM_PROVIDERS entry; the shared one (asked on the main setup
 *  screen) always shows as registered and can't be unregistered here —
 *  there's no "unset" state for it to fall back to.
 *
 *  specs/068 — this is step 1 of the form now: `initialFormState()`
 *  opens straight onto it, and you can't move to agent selection until
 *  at least one credential is registered. */
function ProvidersView(props: { state: InitFormState; width: number }) {
  const s = props.state
  const valueWidth = Math.max(10, props.width - 26)
  const canContinue = canLeaveProvidersStep(s)

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <box style={{ border: true, borderColor: "#58a6ff", flexDirection: "column", height: 3 }}>
        <text style={{ fg: "#58a6ff" }}>
          Orchestr<span style={{ fg: "#d29922" }}>AI</span> — Providers
        </text>
      </box>
      <text style={{ fg: "#8b949e" }}>Step 1 — which LLM providers do you have? Register a key for each.</text>
      <text> </text>

      {(() => {
        const registeredCount = LLM_PROVIDERS.filter((p) => keyForProvider(s, p)).length
        return LLM_PROVIDERS.map((provider, index) => {
        const key = keyForProvider(s, provider)
        // specs/070 — "(default for agents)" only on the provider that is
        // actually the primary AND registered, and only when more than one
        // provider has a key (with just one, "primary" is noise). No label
        // at all before anything is registered — the old "(shared default)"
        // pinned to an unregistered anthropic was just the fresh-form
        // default leaking through.
        const isPrimary = provider === s.llmProvider && key !== "" && registeredCount > 1
        const label = isPrimary ? `${provider} (default for agents)` : provider
        const value = key ? maskKey() : "(not registered)"
        return (
          <text key={provider} style={{ bg: s.providersCursor === index ? "#21262d" : undefined }}>
            <span style={{ fg: s.providersCursor === index ? "#58a6ff" : "#8b949e" }}>{s.providersCursor === index ? "▸" : " "} {label.padEnd(24)}</span>
            <span style={{ fg: key ? "#3fb950" : "#6e7681" }}>{bounded(value, valueWidth)}</span>
          </text>
        )
        })
      })()}

      <text> </text>
      {canContinue ? (
        <text style={{ fg: "#3fb950" }}>  Tab past the last row or press Esc to continue to agent selection.</text>
      ) : (
        <text style={{ fg: "#f85149" }}>  Register at least one provider key before continuing.</text>
      )}
      <text style={{ fg: "#8b949e" }}>
        {bounded("↑↓ move · Enter sets key · Backspace unregisters · Tab/Esc continue · ^X save", Math.max(20, props.width - 2))}
      </text>
    </box>
  )
}

function ReviewLine(props: { state: InitFormState; width: number }) {
  const count = props.state.selectedAgents.length
  // specs/072 — "all" and "none" are genuinely different outcomes now
  // (an empty selection writes ORCHESTRAI_ONLY=orchestrator, not a blank
  // "all"), so they need different labels — never showing "all" when
  // the config actually being saved selects zero work agents.
  const summary = count === props.state.allAgents.length ? "all" : count === 0 ? "none (orchestrator only)" : `${count} selected`

  // specs/070 — every selected agent that has a harness runs its LLM path
  // (selecting it is the decision), so this line just names those, derived
  // from the selection via the same helper the serializer uses.
  const enabled: string[] = []
  for (const field of agentLlmFieldsFor(props.state)) {
    const entry = AGENT_LLM_HARNESSES.find((h) => h.field === field)
    if (entry) enabled.push(entry.component)
  }

  // The full target path used to be repeated here, unbounded — a real
  // overflow risk (the exact class of bug specs/048 hit twice live), and
  // redundant besides: it is already shown in its own bordered box three
  // rows above. Only the filename it lands in is worth repeating, and the
  // one genuinely variable part left (the harness list) gets whatever width
  // is actually free, so this line can never wrap regardless of terminal
  // size or how many harnesses are on.
  const prefix = ".orchestrai\\config.env  ·  agents: "
  const middle = `${summary}  ·  Agent LLM: `
  const llmBudget = Math.max(6, props.width - 2 - prefix.length - middle.length)
  return (
    <text style={{ fg: "#8b949e" }}>
      {prefix}
      <span style={{ fg: "#c9d1d9" }}>{summary}</span>
      {"  ·  Agent LLM: "}
      <span style={{ fg: enabled.length > 0 ? "#3fb950" : "#8b949e" }}>
        {bounded(enabled.length > 0 ? enabled.join(", ") : "none", llmBudget)}
      </span>
    </text>
  )
}

// Injected at start() so this file never imports `fs` directly — keeps
// init-form-state.ts's own "pure, no fs" boundary honest one layer up too,
// and matches init-form-state.ts's own validate()'s injected-predicate
// pattern.
const initGlobals = { dirExists: (_p: string): boolean => true }

export function setDirExistsChecker(fn: (p: string) => boolean): void {
  initGlobals.dirExists = fn
}
