// specs/048-guided-init-experience/spec.md — Phase 1.
//
// Pure state/logic for the full-screen `orchestrai init` setup form. No
// OpenTUI, no React, no fs — everything here is testable with `bun:test`
// alone, mirroring how apps/tui/tui-state.ts isolates logic from rendering
// for the workspace TUI.
//
// The load-bearing rule for this file: it never decides what a valid
// configuration *is*. It produces the existing `WizardConfig` shape, which
// the existing `formatConfigEnv`/`writeWizardConfig` then serialize —
// exactly as the classic prompt wizard does. One config contract, several
// input surfaces (specs/048 form, specs/049 browser page, the classic
// wizard); apps/supervisor/init-form-state.test.ts asserts they agree
// byte-for-byte.

import { AGENT_LLM_HARNESSES, LLM_PROVIDERS, componentApiKeyVar, componentModelVar, componentProviderVar, providerKeyVar, type AgentLlmField, type LlmProvider, type WizardConfig } from "./init-wizard"
import { LLM_COMPONENTS, type LlmComponent } from "../../packages/shared/llm-model-factory"
import { SERVICE_PORT_ENV_VARS, DEFAULT_SERVICE_PORTS, type ServicePortName } from "../../packages/shared/service-ports"
import { DEFAULT_HARNESS_RECURSION_LIMIT, HARNESS_RECURSION_LIMIT_ENV_VAR } from "../../packages/shared/harness-limits"
import type { DiscoveredModel } from "./model-discovery"

// specs/070 — the setup screen is Target → Agents → Models now. The
// per-agent LLM toggle fields (specs/050) and the setup-screen Provider /
// API-key rows are gone: selecting an agent IS the "make it an LLM agent"
// decision, and provider + key are owned by the Providers step (specs/068).
// specs/071 — "Models" replaces the single "llmModel" field: it is now a
// whole section (the shared model + one row per selected LLM agent),
// folded into this same screen instead of living behind a separate `m`
// view. `focus: "models"` means "the Models section has focus"; which row
// inside it is tracked by `modelsCursor`, mirroring how `agentCursor`
// already works for the Agents list independent of `focus`.
// specs/073 — "Ports" is a third section below Models: one row per
// service (all 6, unlike Models which only lists selected LLM agents —
// a port applies to a service regardless of whether it's currently
// selected to start), tracked the same way via `portsCursor`.
// specs/125-configurable-harness-recursion-limit/spec.md — "Harness
// limit" is a fourth, single-row field below Ports: the shared
// ORCHESTRAI_HARNESS_RECURSION_LIMIT override, editable the same way a
// Ports row is (digits only, empty means "use the default"), but with no
// per-service list — just one value for all five agent harnesses.
export type FormFieldId = "targetPath" | "agents" | "models" | "ports" | "harnessLimit"

export interface InitFormState {
  /** Absolute path the agents will operate on. Validated, not assumed. */
  targetPath: string
  /** Every selectable agent, in display order — the 5 real agents only.
   *  specs/034: orchestrator/mcp:http are implied, never choosable. */
  allAgents: string[]
  /** Which agents are ticked. Order follows `allAgents`, not click order. */
  selectedAgents: string[]
  llmProvider: LlmProvider
  llmModel: string
  /** Held here only so it can be written; never rendered. The form shows
   *  the existing maskKey() output instead (which is a fixed-length mask,
   *  deliberately not a partial reveal). */
  llmApiKey: string
  /** specs/063/071 — which screen is showing. The Providers view is a
   *  full-screen early return in the renderer, not extra rows on the
   *  setup form: the setup form already has to scroll at the 80×24
   *  minimum, and specs/012's help view and specs/046's chat view both
   *  established this pattern here precisely so a new surface costs the
   *  row budget nothing. specs/071 retired the separate Models view —
   *  its content is now the setup screen's own Models section, so there
   *  are only two screens left. */
  view: "setup" | "providers"
  /** Per-component model overrides. Always holds every component; "" means
   *  "use the shared model", and writes no line at all. */
  modelOverrides: Record<LlmComponent, string>
  /** specs/071 — which row of the setup screen's Models section is
   *  highlighted: 0 is always `"shared / default"`; 1..N are the
   *  components of `modelsRows(state)` (one per selected LLM agent).
   *  Independent of `focus` the same way `agentCursor` is — set when
   *  `focus` moves onto `"models"`, kept afterward so leaving and coming
   *  back remembers the row. */
  modelsCursor: number
  /** specs/063-init-per-component-provider-and-key/spec.md — the
   *  Providers screen. `llmProvider`/`llmApiKey` above are always the
   *  "shared default" credential (unchanged, still asked on the main
   *  setup screen); this tracks any ADDITIONAL providers registered with
   *  their own key, beyond that one. A component's Models-screen provider
   *  picker can only ever choose from `llmProvider` plus the keys of this
   *  record — by construction, never a provider with no registered key. */
  extraProviders: Partial<Record<LlmProvider, string>>
  /** Which row the Providers screen has focused — one row per
   *  `LLM_PROVIDERS` entry, in order. */
  providersCursor: number
  /** specs/063 — per-component provider overrides, the Models screen's
   *  provider picker. Absent/undefined means "(shared default)" — the
   *  same convention `modelOverrides`' empty string already uses, just
   *  shaped as "key present or not" since `LlmProvider` has no empty
   *  value of its own. */
  providerOverrides: Partial<Record<LlmComponent, LlmProvider>>
  /** specs/063 — live-fetched model lists, keyed by provider so a
   *  provider already fetched this session isn't re-fetched every time a
   *  row resolves to it. Session-only UI state — never seeded, never
   *  written to disk. */
  discoveredModels: Partial<Record<LlmProvider, DiscoveredModel[]>>
  modelFetchStatus: Partial<Record<LlmProvider, "idle" | "loading" | "error">>
  modelFetchError: Partial<Record<LlmProvider, string>>
  /** specs/068 — when the focused Models-section row is in list-selection
   *  mode (an arrow-selectable list of the live-fetched model ids) rather
   *  than free-text entry. Only ever true for one row at a time, since only
   *  one row is focused; moving `modelsCursor` clears it. */
  modelPickerOpen: boolean
  /** specs/068 — the sub-cursor inside that list. */
  modelPickerCursor: number
  /** Which field currently has keyboard focus. */
  focus: FormFieldId
  /** Which row inside the agent list is highlighted, independent of focus. */
  agentCursor: number
  /** specs/073-configurable-service-ports/spec.md — the Ports section.
   *  One entry per overridden service; the raw typed string (not yet
   *  parsed), so a row mid-edit (e.g. an empty string, or briefly out of
   *  range while typing "30" on the way to "3002") never loses characters
   *  to a validating setter. Absent or "" means "use the default port". */
  portOverrides: Partial<Record<ServicePortName, string>>
  /** Which row of the Ports section is highlighted, independent of focus —
   *  mirrors `agentCursor`/`modelsCursor`. */
  portsCursor: number
  /** specs/125-configurable-harness-recursion-limit/spec.md — the raw
   *  typed override for ORCHESTRAI_HARNESS_RECURSION_LIMIT, mirroring
   *  `portOverrides`' own convention: the raw string, not yet parsed, so
   *  a value mid-edit never loses characters to a validating setter.
   *  "" means "use the default" (40). */
  harnessLimitOverride: string
}

// specs/070/071 — the setup screen's focusable fields, top to bottom. The
// per-agent LLM toggles and the Provider/API-key rows are gone (see the
// FormFieldId comment above); Models is the only LLM field left here, and
// each of its rows is a live picker (specs/068) fed by the Providers
// step's credential.
const SETUP_FIELDS: FormFieldId[] = ["targetPath", "agents", "models", "ports", "harnessLimit"]

/** specs/050/070/072 — every agent that will actually start AND has its
 *  own harness — i.e. every harness agent literally present in
 *  `selectedAgents`. specs/070: selecting the agent IS the decision to
 *  run its LLM path — there is no separate on/off any more, so every
 *  field this returns is written `=1`.
 *
 *  specs/072 — deliberately no "empty means all" fallback. A *fresh*
 *  form's `selectedAgents` is already the full explicit agent array
 *  (`initialFormState()`'s default), never empty, so this is safe: the
 *  only way `selectedAgents` is ever genuinely `[]` is a user
 *  individually unticking every box — the deliberate "I want none of
 *  these" gesture `selectedAgentsToOnly()` now also honours, rather than
 *  the ambiguous blank-text-prompt case the classic wizard alone still
 *  defaults to "all" for (`parseServiceSelection`, untouched). */
export function agentLlmFieldsFor(state: Pick<InitFormState, "selectedAgents">): AgentLlmField[] {
  return AGENT_LLM_HARNESSES.filter((h) => state.selectedAgents.includes(h.agent)).map((h) => h.field)
}

export function visibleFields(_state: InitFormState): FormFieldId[] {
  return SETUP_FIELDS
}

export function moveFocus(state: InitFormState, direction: 1 | -1): InitFormState {
  const fields = visibleFields(state)
  const current = fields.indexOf(state.focus)
  // An unknown/hidden current focus (e.g. the harness was just switched off
  // while focus sat on the model field) resolves to the first field rather
  // than throwing or leaving focus stranded off-screen.
  if (current === -1) return { ...state, focus: fields[0]! }
  const next = (current + direction + fields.length) % fields.length
  return { ...state, focus: fields[next]! }
}

/** Keeps focus valid after a change that can hide fields. Called by the
 *  toggles rather than left to the renderer to remember. */
function reconcileFocus(state: InitFormState): InitFormState {
  const fields = visibleFields(state)
  return fields.includes(state.focus) ? state : { ...state, focus: fields[fields.length - 1]! }
}

export function moveAgentCursor(state: InitFormState, direction: 1 | -1): InitFormState {
  if (state.allAgents.length === 0) return state
  const next = Math.min(state.allAgents.length - 1, Math.max(0, state.agentCursor + direction))
  return { ...state, agentCursor: next }
}

/** Toggles the agent under the cursor. Selection is stored in `allAgents`
 *  order so the written config is stable regardless of the order the user
 *  happened to tick things in — a re-run diffs cleanly. */
export function toggleAgentAtCursor(state: InitFormState): InitFormState {
  const name = state.allAgents[state.agentCursor]
  if (!name) return state
  const has = state.selectedAgents.includes(name)
  const next = has
    ? state.selectedAgents.filter((n) => n !== name)
    : state.allAgents.filter((n) => n === name || state.selectedAgents.includes(n))
  const withSelection = { ...state, selectedAgents: next }
  // specs/071 — deselecting an agent can shrink the Models section out
  // from under a cursor sitting on a now-gone row; clamp it back into
  // range (and close any open picker on that row) rather than leaving it
  // pointing at a different row than the user thinks.
  const modelsCursor = Math.min(state.modelsCursor, modelsRows(withSelection).length - 1)
  // specs/070 — the setup field list is static now (no per-agent gates to
  // hide), so this can no longer strand focus. reconcileFocus is a cheap
  // no-op here but kept for symmetry with any future dynamic field.
  return reconcileFocus({ ...withSelection, modelsCursor, modelPickerOpen: false })
}

// ============================================================
// specs/071-models-view-inline-provider-in-picker/spec.md — the setup
// screen's own Models section, replacing the separate `m` view
// specs/050/063/068 used to reach this through.
// ============================================================

/** The Models section's rows, in render order: `"shared"` first, then the
 *  two always-on components (`"orchestrator"`, `"conversation"` —
 *  present regardless of `selectedAgents`, since neither is tied to a
 *  work-agent selection: `orchestrator` drives every `plan-task`,
 *  `conversation` drives every `/ask` answer synthesis), then one
 *  `LlmComponent` per selected agent that has an LLM harness.
 *
 *  specs/095-init-models-section-orchestrator-conversation-rows/spec.md
 *  — specs/071 originally excluded `orchestrator`/`conversation` here
 *  ("both fall back to the shared model, overriding them stays a
 *  hand-edit"), reasoning that held for the common case but left a real
 *  gap: a hand-edited override that happens to be *wrong* was invisible
 *  anywhere in setup, with no way to see or correct it short of manually
 *  re-inspecting the config file. Live-caught, 2026-09-15: a real
 *  `ORCHESTRAI_CONVERSATION_LLM_MODEL` override was set to a
 *  text-to-speech-only model, silently breaking every chat answer
 *  synthesis call with no error, all session. Both rows are added back
 *  using mechanisms that were already fully generic over any
 *  `LlmComponent` before this spec — confirmed by reading
 *  `rowComponentAtCursor()`, `setModelAtCursor()`, `resolvedProviderAtCursor()`,
 *  and `formStateToWizardConfig()`'s own `modelOverrides` loop, none of
 *  which special-cased "agent components only." Derived from the exact
 *  same `agentLlmFieldsFor()` the serializer uses for the per-agent
 *  rows, so the screen and the written file can never disagree about
 *  which of those exist. */
export function modelsRows(state: Pick<InitFormState, "selectedAgents">): ("shared" | LlmComponent)[] {
  const components = agentLlmFieldsFor(state).map((field) => AGENT_LLM_HARNESSES.find((h) => h.field === field)!.component)
  return ["shared", "orchestrator", "conversation", ...components]
}

/** Which component the highlighted Models row edits, or null for the
 *  `"shared"` row (including a stale cursor pointing past the current
 *  row count — treated as "shared" rather than throwing). */
function rowComponentAtCursor(state: InitFormState): LlmComponent | null {
  const row = modelsRows(state)[state.modelsCursor]
  return row && row !== "shared" ? row : null
}

export function moveModelsCursor(state: InitFormState, direction: 1 | -1): InitFormState {
  const count = modelsRows(state).length
  const next = (state.modelsCursor + direction + count) % count
  // specs/068 — leaving a row also leaves that row's list picker; the
  // picker is a mode of the focused row, not a persistent panel.
  return { ...state, modelsCursor: next, modelPickerOpen: false }
}

/** Sets the focused row's model. An empty string is meaningful, not a
 *  no-op: it clears the override so the shared model applies again, which
 *  is what the row renders as "(shared)". */
export function setModelAtCursor(state: InitFormState, value: string): InitFormState {
  const component = rowComponentAtCursor(state)
  if (!component) return { ...state, llmModel: value }
  return { ...state, modelOverrides: { ...state.modelOverrides, [component]: value } }
}

/** What the focused row is currently editing, so the renderer and the
 *  keyboard handler read the same value. */
export function modelAtCursor(state: InitFormState): string {
  const component = rowComponentAtCursor(state)
  return component ? state.modelOverrides[component] : state.llmModel
}

// ============================================================
// specs/073-configurable-service-ports/spec.md — the Ports section: one
// row per service (all 6, always — unlike Models, this doesn't depend on
// the agent selection, since a service's port matters regardless of
// whether it's currently chosen to start).
// ============================================================

/** Fixed row order, matching the spec's own table. */
export const SERVICE_PORT_ROWS: ServicePortName[] = ["orchestrator", "devops", "testing", "documentation", "security", "mcpHttp"]

export function movePortsCursor(state: InitFormState, direction: 1 | -1): InitFormState {
  const count = SERVICE_PORT_ROWS.length
  const next = (state.portsCursor + direction + count) % count
  return { ...state, portsCursor: next }
}

export function serviceAtPortsCursor(state: InitFormState): ServicePortName {
  return SERVICE_PORT_ROWS[state.portsCursor]!
}

/** The focused row's raw typed value, or "" if unedited (meaning "use the
 *  default"). */
export function portOverrideAtCursor(state: InitFormState): string {
  return state.portOverrides[serviceAtPortsCursor(state)] ?? ""
}

/** Sets the focused row's raw value. An empty string clears the override
 *  back to "use the default" — same convention `modelOverrides`'s empty
 *  string already uses. */
export function setPortOverrideAtCursor(state: InitFormState, value: string): InitFormState {
  const service = serviceAtPortsCursor(state)
  const portOverrides = { ...state.portOverrides }
  if (value.trim() === "") delete portOverrides[service]
  else portOverrides[service] = value
  return { ...state, portOverrides }
}

/** Parses one service's resolved port: its own override when the row has
 *  one (and it parses as a valid 1-65535 integer), else that service's
 *  default. Returns null for a present-but-invalid override — the
 *  renderer/validate() surface that distinctly from either a valid
 *  override or "no override at all". */
export function resolvedPort(state: Pick<InitFormState, "portOverrides">, service: ServicePortName): number | null {
  const raw = state.portOverrides[service]
  if (raw === undefined || raw.trim() === "") return DEFAULT_SERVICE_PORTS[service]
  const parsed = Number(raw.trim())
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null
  return parsed
}

/** Every validation problem in the Ports section: an out-of-range/
 *  non-numeric override, or two services resolving to the same port.
 *  Returns [] when every row is fine — including when nothing has been
 *  overridden at all, since every default is already distinct. */
export function portsValidationErrors(state: Pick<InitFormState, "portOverrides">): string[] {
  const errors: string[] = []
  const resolved: Partial<Record<ServicePortName, number>> = {}
  for (const service of SERVICE_PORT_ROWS) {
    const value = resolvedPort(state, service)
    if (value === null) errors.push(`${service}: must be a port number 1-65535`)
    else resolved[service] = value
  }
  const byPort = new Map<number, ServicePortName[]>()
  for (const [service, port] of Object.entries(resolved) as [ServicePortName, number][]) {
    const list = byPort.get(port) ?? []
    list.push(service)
    byPort.set(port, list)
  }
  for (const [port, services] of byPort) {
    if (services.length > 1) errors.push(`port ${port} used by more than one service: ${services.join(", ")}`)
  }
  return errors
}

// ============================================================
// specs/125-configurable-harness-recursion-limit/spec.md — the shared
// ORCHESTRAI_HARNESS_RECURSION_LIMIT override: one single-line field,
// below Ports, mirroring the same raw-string/validate/resolve shape a
// Ports row already established, minus the per-service list (there's
// only one value here, for all five agent harnesses at once).
// ============================================================

/** The focused-or-not resolved value: the override when present and
 *  valid, else the shared default (40). Returns null for a present but
 *  invalid override — same distinct-null convention `resolvedPort()`
 *  already established, so the renderer/validate() can tell "no
 *  override" apart from "a bad one". */
export function resolvedHarnessLimit(state: Pick<InitFormState, "harnessLimitOverride">): number | null {
  const raw = state.harnessLimitOverride.trim()
  if (raw === "") return DEFAULT_HARNESS_RECURSION_LIMIT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return null
  return parsed
}

/** Sets the raw typed override. Empty clears it back to "use the
 *  default" — same convention `setPortOverrideAtCursor()` already uses. */
export function setHarnessLimitOverride(state: InitFormState, value: string): InitFormState {
  return { ...state, harnessLimitOverride: value }
}

// ============================================================
// specs/063-init-per-component-provider-and-key/spec.md — the
// Providers screen (register credentials) and the Models screen's own
// provider picker + live model discovery per row.
// ============================================================

/** Every provider with a registered key, in `LLM_PROVIDERS` order — the
 *  shared default (`llmProvider`/`llmApiKey`, always present, asked
 *  unconditionally on the main setup screen) plus whatever's in
 *  `extraProviders`. This is the exact, complete list a component's
 *  provider picker is allowed to offer — computed here once so the
 *  picker, the write path, and tests all agree on what "available"
 *  means. */
export function availableProviders(state: InitFormState): LlmProvider[] {
  const extra = LLM_PROVIDERS.filter((p) => p !== state.llmProvider && state.extraProviders[p])
  return [state.llmProvider, ...extra]
}

/** The registered key for a given provider, or "" if it isn't
 *  registered. The primary provider's key normally lives in `llmApiKey`,
 *  every other provider's in `extraProviders`.
 *
 *  specs/070 — loss-proof: if the primary branch is empty, fall back to
 *  `extraProviders[provider]` anyway. This closes the seam where a key
 *  registered for provider X (into `extraProviders[X]` while X was not
 *  yet primary) became unreachable the moment X was made primary and
 *  `keyForProvider` started reading the still-empty `llmApiKey`. A
 *  registered key is now found regardless of which slot holds it. */
export function keyForProvider(state: InitFormState, provider: LlmProvider): string {
  if (provider === state.llmProvider && state.llmApiKey) return state.llmApiKey
  return state.extraProviders[provider] ?? (provider === state.llmProvider ? state.llmApiKey : "")
}

export function openProvidersView(state: InitFormState): InitFormState {
  return { ...state, view: "providers", providersCursor: 0 }
}

/** specs/068 — the Providers screen is step 1 of the form now
 *  (`initialFormState()` opens on it). Advancing to agent selection is
 *  gated: at least one credential must be registered — the shared key,
 *  or any extra provider's. Same "can't proceed without X" shape the
 *  target-path check already is; it blocks *advancing*, never saving. */
export function canLeaveProvidersStep(state: InitFormState): boolean {
  if (state.llmApiKey.trim() !== "") return true
  return LLM_PROVIDERS.some((p) => (state.extraProviders[p] ?? "").trim() !== "")
}

/** Leaves the Providers screen for the setup form. specs/068 made this a
 *  gated forward step: it only advances once `canLeaveProvidersStep()`
 *  holds, otherwise it is a no-op and the renderer shows the "register at
 *  least one provider" message. Esc, Tab-past-the-last-row and the `p`-key
 *  detour's own Esc all route through here, so the gate lives in exactly
 *  one place. */
export function closeProvidersView(state: InitFormState): InitFormState {
  if (!canLeaveProvidersStep(state)) return state
  return { ...state, view: "setup" }
}

export function moveProvidersCursor(state: InitFormState, direction: 1 | -1): InitFormState {
  const next = (state.providersCursor + direction + LLM_PROVIDERS.length) % LLM_PROVIDERS.length
  return { ...state, providersCursor: next }
}

export function providerAtProvidersCursor(state: InitFormState): LlmProvider {
  return LLM_PROVIDERS[state.providersCursor]!
}

/** Drops any component provider-override that points at `provider` — used
 *  when that provider's key goes away, so an override never dangles at a
 *  provider with no key. */
function withoutOverridesFor(state: InitFormState, provider: LlmProvider): InitFormState {
  const providerOverrides: InitFormState["providerOverrides"] = {}
  for (const [component, assigned] of Object.entries(state.providerOverrides) as [LlmComponent, LlmProvider][]) {
    if (assigned !== provider) providerOverrides[component] = assigned
  }
  return { ...state, providerOverrides }
}

/** Registers (or replaces) the focused row's key.
 *
 *  specs/070 §3 — the **primary** provider (`llmProvider` + `llmApiKey`,
 *  i.e. what becomes `ORCHESTRAI_LLM_PROVIDER` / `_API_KEY` and the
 *  default every agent falls back to) is whichever provider is registered
 *  **first**, not a hardcoded default. `llmProvider` still defaults to
 *  `"anthropic"` on a fresh form, but with no key it means nothing — the
 *  first `registerProviderKey` overrides it. Once a primary key exists,
 *  further registrations land in `extraProviders`. */
export function registerProviderKey(state: InitFormState, key: string): InitFormState {
  const provider = providerAtProvidersCursor(state)
  if (!state.llmApiKey.trim()) return { ...state, llmProvider: provider, llmApiKey: key }
  if (provider === state.llmProvider) return { ...state, llmApiKey: key }
  return { ...state, extraProviders: { ...state.extraProviders, [provider]: key } }
}

/** Unregisters the focused row's key. specs/070 — unregistering the
 *  **primary** is allowed now: the first registered extra (in
 *  `LLM_PROVIDERS` order) is promoted to primary; if there is none, the
 *  primary key is simply cleared (the Providers-step gate then blocks
 *  advancing until something is registered again). Any component override
 *  pointing at a now-keyless provider is dropped either way. */
export function unregisterProviderKey(state: InitFormState): InitFormState {
  const provider = providerAtProvidersCursor(state)
  if (provider === state.llmProvider) {
    const promoted = LLM_PROVIDERS.find((p) => p !== provider && state.extraProviders[p])
    const extraProviders = { ...state.extraProviders }
    const promotedKey = promoted ? extraProviders[promoted]! : ""
    if (promoted) delete extraProviders[promoted]
    return withoutOverridesFor(
      { ...state, llmProvider: promoted ?? state.llmProvider, llmApiKey: promotedKey, extraProviders },
      provider,
    )
  }
  const extraProviders = { ...state.extraProviders }
  delete extraProviders[provider]
  return withoutOverridesFor({ ...state, extraProviders }, provider)
}

/** Sets a component's provider override in the Models section. Only ever
 *  called with a provider `availableProviders()` actually returned —
 *  the renderer's own picker enumerates from that same list — so this
 *  can never assign a provider with no key. Passing `null` clears the
 *  override back to "(shared default)". A no-op on the `"shared"` row —
 *  it has no override of its own to set. */
export function setProviderOverrideAtCursor(state: InitFormState, provider: LlmProvider | null): InitFormState {
  const component = rowComponentAtCursor(state)
  if (!component) return state
  const providerOverrides = { ...state.providerOverrides }
  if (provider === null) delete providerOverrides[component]
  else providerOverrides[component] = provider
  return { ...state, providerOverrides }
}

/** The provider the highlighted Models row actually resolves to: its own
 *  override if set, else the shared default. The `"shared"` row itself
 *  always resolves to the shared provider, matching what typing in that
 *  row has always meant. */
export function resolvedProviderAtCursor(state: InitFormState): LlmProvider {
  const component = rowComponentAtCursor(state)
  if (!component) return state.llmProvider
  return state.providerOverrides[component] ?? state.llmProvider
}

/** Cycling for a component row's own provider override — cycles through
 *  `(shared default)` (represented as no override) plus every registered
 *  extra provider, in `availableProviders()` order (skipping the shared
 *  one itself there, since "(shared)" is its own first stop in this cycle
 *  already). A no-op — returning `state` itself, unchanged, so callers can
 *  detect "nothing to cycle" by reference — on the `"shared"` row (its own
 *  provider is set on the Providers step, not here) or when no extra
 *  provider is registered at all. */
export function cycleProviderOverrideAtCursor(state: InitFormState, direction: 1 | -1): InitFormState {
  const component = rowComponentAtCursor(state)
  if (!component) return state
  const extras = availableProviders(state).filter((p) => p !== state.llmProvider)
  if (extras.length === 0) return state
  // The cycle is [null (shared), ...extras]; find where the CURRENT
  // override sits in that list (null if unset) and step by `direction`.
  const current = state.providerOverrides[component] ?? null
  const order: (LlmProvider | null)[] = [null, ...extras]
  const idx = order.indexOf(current)
  const next = order[(idx + direction + order.length) % order.length]!
  return setProviderOverrideAtCursor(state, next)
}

/** specs/132 — switches which registered provider is the shared default,
 *  in `LLM_PROVIDERS` order. Keys never move between providers; the old
 *  primary's key just goes back into `extraProviders`. The shared model is
 *  cleared (a model id belongs to one provider), and any component row
 *  that set its own model while following the shared provider is pinned
 *  to the OLD provider, so it keeps a model that actually exists there.
 *  Returns `state` itself when fewer than two providers are registered. */
export function cycleSharedProvider(state: InitFormState, direction: 1 | -1): InitFormState {
  const registered = LLM_PROVIDERS.filter((p) => keyForProvider(state, p).trim() !== "")
  if (registered.length < 2) return state
  const oldPrimary = state.llmProvider
  const idx = registered.indexOf(oldPrimary)
  const next = registered[(idx + direction + registered.length) % registered.length]!
  const extraProviders = { ...state.extraProviders }
  if (state.llmApiKey.trim()) extraProviders[oldPrimary] = state.llmApiKey
  const nextKey = keyForProvider(state, next)
  delete extraProviders[next]
  const providerOverrides = { ...state.providerOverrides }
  for (const component of LLM_COMPONENTS) {
    if (!providerOverrides[component] && state.modelOverrides[component].trim()) providerOverrides[component] = oldPrimary
  }
  return {
    ...state,
    llmProvider: next,
    llmApiKey: nextKey,
    llmModel: "",
    extraProviders,
    providerOverrides,
    modelPickerCursor: 0,
  }
}

/** specs/132 — ←/→ on any Models row: the "shared / default" row cycles
 *  the shared provider, a component row cycles its own override. */
export function cycleRowProvider(state: InitFormState, direction: 1 | -1): InitFormState {
  return rowComponentAtCursor(state) === null ? cycleSharedProvider(state, direction) : cycleProviderOverrideAtCursor(state, direction)
}

/** specs/071 — cycling a row's provider while its picker is OPEN also
 *  resets the model sub-cursor to the top, since the list underneath it
 *  just changed to a different provider's models. Relies on
 *  `cycleProviderOverrideAtCursor()`'s own no-op contract (returns the
 *  same `state` reference when there's nothing to cycle) so pressing
 *  ←/→ on the shared row, or with no extra provider registered, never
 *  disturbs `modelPickerCursor` for no reason. */
export function cyclePickerProvider(state: InitFormState, direction: 1 | -1): InitFormState {
  const cycled = cycleRowProvider(state, direction)
  return cycled === state ? state : { ...cycled, modelPickerCursor: 0 }
}

/** Whether the highlighted row has anything to open a picker for: a real
 *  model list for its resolved provider, or — for a component row only —
 *  a second registered provider to switch to even before that provider's
 *  own list has loaded. This is what lets `Enter` open the picker
 *  specifically to switch a component onto a different provider. */
export function canOpenRowPicker(state: InitFormState): boolean {
  if (canPickModelFromList(state)) return true
  // specs/132 — the shared row can switch provider too now.
  return availableProviders(state).length > 1
}

/** Pure setters for the live-fetch lifecycle — the actual network call
 *  lives in the renderer (this file stays I/O-free); these just record
 *  the outcome so the renderer and its tests agree on what state a
 *  fetch leaves behind. */
export function setModelFetchLoading(state: InitFormState, provider: LlmProvider): InitFormState {
  return { ...state, modelFetchStatus: { ...state.modelFetchStatus, [provider]: "loading" }, modelFetchError: { ...state.modelFetchError, [provider]: undefined } }
}
export function setModelFetchSuccess(state: InitFormState, provider: LlmProvider, models: DiscoveredModel[]): InitFormState {
  return {
    ...state,
    discoveredModels: { ...state.discoveredModels, [provider]: models },
    modelFetchStatus: { ...state.modelFetchStatus, [provider]: "idle" },
    modelFetchError: { ...state.modelFetchError, [provider]: undefined },
  }
}
export function setModelFetchError(state: InitFormState, provider: LlmProvider, error: string): InitFormState {
  return { ...state, modelFetchStatus: { ...state.modelFetchStatus, [provider]: "error" }, modelFetchError: { ...state.modelFetchError, [provider]: error } }
}

// ============================================================
// specs/068-init-providers-first-flow-and-model-picker/spec.md — the
// Models screen's per-row model PICKER: an arrow-selectable list of the
// real, live-fetched model ids, with free-text typing kept as the
// fallback for a failed fetch or an id the list doesn't contain.
// ============================================================

/** How many model ids the picker shows at once; a longer list pages
 *  under the sub-cursor. Deliberately small — the Models view is a
 *  fixed, non-scrolling region (specs/047), so every line here counts
 *  against its row budget at the 80×24 minimum. */
export const MODEL_PICKER_WINDOW = 5

/** The live-fetched model list for whatever provider the focused row
 *  resolves to, or [] when nothing has been fetched (or the fetch
 *  failed / timed out) — the `"shared"` row for the shared provider,
 *  each component row for its own resolved provider. */
export function modelListForCursor(state: InitFormState): DiscoveredModel[] {
  return state.discoveredModels[resolvedProviderAtCursor(state)] ?? []
}

/** Whether the focused row can offer a list to pick from — a real model
 *  row whose resolved provider returned at least one model. The renderer
 *  shows the "Enter to pick / type instead" affordance exactly when this
 *  is true. */
export function canPickModelFromList(state: InitFormState): boolean {
  return modelListForCursor(state).length > 0
}

/** Enters list-selection mode for the focused row, starting the
 *  sub-cursor on the row's current value if it's in the list (so
 *  reopening the picker lands on what's already chosen), else at the
 *  top. A no-op when `canOpenRowPicker()` is false — the row stays in
 *  free-text mode, unchanged from specs/063. specs/071 — this can now
 *  open with an EMPTY list (a component row with a second provider
 *  registered but whose own models haven't loaded yet), specifically so
 *  `Enter` can be used to switch that row onto a different provider. */
export function enterModelSelectMode(state: InitFormState): InitFormState {
  if (!canOpenRowPicker(state)) return state
  const models = modelListForCursor(state)
  const current = modelAtCursor(state)
  const found = models.findIndex((m) => m.id === current)
  return { ...state, modelPickerOpen: true, modelPickerCursor: found === -1 ? 0 : found }
}

/** Leaves list-selection mode without changing the row's value — "type
 *  it in instead". */
export function exitModelSelectMode(state: InitFormState): InitFormState {
  return { ...state, modelPickerOpen: false }
}

/** Moves the picker sub-cursor, wrapping, bounded to the current list's
 *  length — the same wrap behavior every other cursor in this file has.
 *  A no-op when the picker isn't open or the list is empty. */
export function moveModelPickerCursor(state: InitFormState, direction: 1 | -1): InitFormState {
  if (!state.modelPickerOpen) return state
  const len = modelListForCursor(state).length
  if (len === 0) return state
  const next = (state.modelPickerCursor + direction + len) % len
  return { ...state, modelPickerCursor: next }
}

/** Picks the highlighted model id, writing it as the focused row's value
 *  through the exact same `setModelAtCursor()` a typed id goes through —
 *  so a list-picked config and a typed one are byte-identical
 *  (specs/068 §3). Closes the picker; the row stays focused so the
 *  result is visible. A no-op when the picker isn't open. */
export function pickModelFromList(state: InitFormState): InitFormState {
  if (!state.modelPickerOpen) return state
  const chosen = modelListForCursor(state)[state.modelPickerCursor]
  if (!chosen) return { ...state, modelPickerOpen: false }
  return { ...setModelAtCursor(state, chosen.id), modelPickerOpen: false }
}

/** Pure window math for the paged picker: given a list length, the
 *  sub-cursor, and the visible window size, the [start, end) slice to
 *  render so the cursor stays in view. Tested directly rather than left
 *  as inline renderer math (the specs/048 precedent for
 *  `fieldScrollOffset`). */
export function modelPickerWindow(total: number, cursor: number, windowSize: number): { start: number; end: number } {
  if (total <= windowSize) return { start: 0, end: total }
  const half = Math.floor(windowSize / 2)
  const start = Math.max(0, Math.min(cursor - half, total - windowSize))
  return { start, end: start + windowSize }
}

export function cycleProvider(state: InitFormState, direction: 1 | -1): InitFormState {
  const current = LLM_PROVIDERS.indexOf(state.llmProvider)
  const next = (current + direction + LLM_PROVIDERS.length) % LLM_PROVIDERS.length
  return { ...state, llmProvider: LLM_PROVIDERS[next]! }
}

// specs/071 — "llmModel" is no longer set through here: the Models
// section's rows (including the shared one) go through
// setModelAtCursor() instead, since which state field a row writes to
// depends on modelsCursor now. "llmApiKey" was already only ever set via
// registerProviderKey() on the Providers screen (specs/070 removed the
// setup screen's own API-key row). targetPath is what's left.
export function setText(state: InitFormState, field: "targetPath", value: string): InitFormState {
  return { ...state, [field]: value }
}

// ============================================================
// Validation
// ============================================================

export interface FormValidation {
  /** Field id → message. Absent means that field is fine. */
  errors: Partial<Record<FormFieldId, string>>
  canSave: boolean
}

/** `dirExists` is injected rather than importing fs, so this stays pure and
 *  directly testable. The renderer passes the real filesystem check. */
export function validate(state: InitFormState, dirExists: (path: string) => boolean): FormValidation {
  const errors: Partial<Record<FormFieldId, string>> = {}

  const target = state.targetPath.trim()
  if (!target) errors.targetPath = "A target project path is required."
  else if (!dirExists(target)) errors.targetPath = "Not an existing directory."

  // Mirrors the classic wizard's own rule: gemini has no default model, so
  // one must be given. specs/029 made that deliberate. Unconditional now —
  // specs/051 — the provider/model fields are always present, not gated
  // behind a needsProvider() check that no longer exists. specs/071 —
  // this is the "shared" Models row now, flagged under "models" (the one
  // FormFieldId the whole section shares) rather than a removed
  // "llmModel" field.
  if (state.llmProvider === "gemini" && !state.llmModel.trim()) {
    errors.models = "A model is required for gemini."
  }

  // specs/073-configurable-service-ports/spec.md — an out-of-range value
  // or a collision between two services blocks saving, same as every
  // other field-level error here.
  const portProblems = portsValidationErrors(state)
  if (portProblems.length > 0) errors.ports = portProblems.join("; ")

  // specs/125-configurable-harness-recursion-limit/spec.md — a non-empty
  // value that doesn't parse as an integer >= 1 blocks saving, same as an
  // out-of-range port. The runtime resolver never throws on a bad value
  // (it silently falls back to the default); this is form-level
  // validation only, so the wizard never *writes* a value the resolver
  // would silently discard.
  if (state.harnessLimitOverride.trim() !== "" && resolvedHarnessLimit(state) === null) {
    errors.harnessLimit = "Must be a whole number of 1 or more."
  }

  return { errors, canSave: Object.keys(errors).length === 0 }
}

// ============================================================
// The seam to the existing config contract
// ============================================================

/** Every agent selected is written as "all" (an empty `only`), which is
 *  exactly what the classic wizard produces when the user answers "all" —
 *  keeping the two surfaces byte-identical for the same intent rather than
 *  emitting a redundant explicit list.
 *
 *  specs/072 — an EXPLICITLY EMPTY selection means **no** agents, not
 *  "all": both the TUI and browser checkbox forms start with every box
 *  ticked, so the only way `selectedAgents` is ever genuinely `[]` is a
 *  user individually unticking every one — a deliberate action, unlike
 *  the classic wizard's ambiguous blank-text-prompt case
 *  (`parseServiceSelection`, which still means "all" there, untouched).
 *  Written as `["orchestrator"]` rather than `[]` so the orchestrator
 *  still starts (the invariant `specs/034` already established — a
 *  wizard-written config can never produce a coordinator-less startup)
 *  while no work agent does; `apps/supervisor/index.ts` already supports
 *  exactly this via `--only orchestrator` / `ORCHESTRAI_ONLY=orchestrator`. */
export function selectedAgentsToOnly(state: Pick<InitFormState, "allAgents" | "selectedAgents">): string[] {
  const chosen = state.allAgents.filter((n) => state.selectedAgents.includes(n))
  if (chosen.length === state.allAgents.length) return []
  if (chosen.length === 0) return ["orchestrator"]
  return chosen
}

export function formStateToWizardConfig(state: InitFormState): WizardConfig {
  // Only gates for agents that will actually start are carried across; the
  // rest stay in form state (so the answer survives a deselect/reselect)
  // but write no line at all. Same visibility rule the UI uses, from the
  // same helper — the screen and the file cannot disagree.
  // specs/070 — selecting an agent IS the decision to run its LLM path,
  // so every selected agent that has a harness writes `=1`; a deselected
  // agent's field is not in agentLlmFieldsFor() at all, so it writes no
  // line (absent === off everywhere that reads it — resolveLlmVar() and
  // each agent's own `=== "1"` gate). This deliberately reverses specs/050's
  // "an all-off config writes each gate explicitly `=0`".
  const agentLlm: WizardConfig["agentLlm"] = {}
  for (const field of agentLlmFieldsFor(state)) agentLlm[field] = true
  // specs/050 — only non-empty overrides; an empty row means "use the
  // shared model", which is expressed by writing no line at all.
  const modelOverrides: WizardConfig["modelOverrides"] = {}
  for (const component of LLM_COMPONENTS) {
    const model = state.modelOverrides[component].trim()
    if (model) modelOverrides[component] = model
  }
  // specs/063 — providerOverrides/apiKeyOverrides are derived, not
  // separately held in form state: a component's assigned provider
  // always came from availableProviders() (the shared one, or a
  // registered extra), so its key is always resolvable by looking that
  // provider up the same way keyForProvider() does. This is what makes
  // "provider set, no key" structurally unreachable at the write layer
  // too, not just in the picker's own option list.
  const providerOverrides: WizardConfig["providerOverrides"] = {}
  const apiKeyOverrides: WizardConfig["apiKeyOverrides"] = {}
  for (const [component, provider] of Object.entries(state.providerOverrides) as [LlmComponent, LlmProvider][]) {
    providerOverrides[component] = provider
    apiKeyOverrides[component] = keyForProvider(state, provider)
  }
  // specs/132 — every registered key, used or not, so none is lost on save.
  const providerKeys: WizardConfig["providerKeys"] = {}
  for (const provider of availableProviders(state)) {
    const key = keyForProvider(state, provider).trim()
    if (key) providerKeys[provider] = key
  }
  // specs/073-configurable-service-ports/spec.md — only a validly-parsed
  // override that actually differs from that service's own default is
  // carried across; an invalid in-progress edit (caught by validate()
  // above, which blocks saving) is never written, and an override equal
  // to the default is indistinguishable from no override at all.
  const ports: WizardConfig["ports"] = {}
  for (const service of SERVICE_PORT_ROWS) {
    const value = resolvedPort(state, service)
    if (value !== null && value !== DEFAULT_SERVICE_PORTS[service]) ports[service] = value
  }
  // specs/125-configurable-harness-recursion-limit/spec.md — same rule as
  // ports: only a validly-parsed override that actually differs from the
  // shared default is carried across. An invalid in-progress edit (caught
  // by validate() above, which blocks saving) is never written.
  const harnessRecursionLimitValue = resolvedHarnessLimit(state)
  const harnessRecursionLimit =
    harnessRecursionLimitValue !== null && harnessRecursionLimitValue !== DEFAULT_HARNESS_RECURSION_LIMIT
      ? harnessRecursionLimitValue
      : undefined
  return {
    projectPath: state.targetPath.trim(),
    only: selectedAgentsToOnly(state),
    agentLlm,
    modelOverrides,
    providerOverrides,
    apiKeyOverrides,
    providerKeys,
    ports,
    harnessRecursionLimit,
    // specs/051 — llmProvider is always written now (it's a required field
    // on WizardConfig, matching the classic wizard's own unconditional
    // question). llmModel/llmApiKey stay conditionally undefined when
    // empty — that was never about "is a provider needed", just "did the
    // user leave this blank", matching what formatConfigEnv omits.
    llmProvider: state.llmProvider,
    llmModel: state.llmModel.trim() || undefined,
    llmApiKey: state.llmApiKey || undefined,
  }
}

// ============================================================
// Seeding
// ============================================================

export interface ExistingConfigSeed {
  env: Record<string, string>
  projectPath?: string
}

/** specs/050 — seeds the Models view from whatever is already in the file.
 *  Load-bearing, not a nicety: WIZARD_OWNED_KEYS now owns these variables,
 *  so a value that failed to seed here would be deleted on the next write.
 *  A user who hand-edited an override and never opens the Models view still
 *  round-trips it because of this. */
function seedModelOverrides(env: Record<string, string>): Record<LlmComponent, string> {
  const seeded = {} as Record<LlmComponent, string>
  for (const component of LLM_COMPONENTS) seeded[component] = env[componentModelVar(component)] ?? ""
  return seeded
}

/** specs/073-configurable-service-ports/spec.md — seeds the Ports
 *  section from whatever's already in the file. Load-bearing the same
 *  way seedModelOverrides() is: WIZARD_OWNED_KEYS now owns these
 *  variables, so a value that failed to seed here would be deleted on
 *  the next write. Seeded as the raw string (not re-formatted), so a
 *  hand-edited value round-trips exactly as typed. */
function seedPortOverrides(env: Record<string, string>): Partial<Record<ServicePortName, string>> {
  const seeded: Partial<Record<ServicePortName, string>> = {}
  for (const service of SERVICE_PORT_ROWS) {
    const raw = env[SERVICE_PORT_ENV_VARS[service]]
    if (raw) seeded[service] = raw
  }
  return seeded
}

/** specs/125-configurable-harness-recursion-limit/spec.md — seeds the
 *  harness-limit field from whatever's already in the file. Load-bearing
 *  the same way seedPortOverrides() is: WIZARD_OWNED_KEYS now owns this
 *  variable, so a value that failed to seed here would be deleted on the
 *  next write. Seeded as the raw string (not re-formatted), so a
 *  hand-edited value round-trips exactly as typed. */
function seedHarnessLimitOverride(env: Record<string, string>): string {
  return env[HARNESS_RECURSION_LIMIT_ENV_VAR] ?? ""
}

/** specs/063 — reconstructs the Providers screen's registered-credential
 *  list and each component's provider override from what's already on
 *  disk, so a re-run of `init` never needs anything re-entered. Any
 *  component whose own PROVIDER/API_KEY pair is both present and differs
 *  from the shared provider registers that provider as an "extra" (so it
 *  shows up in availableProviders()) and records the override; a
 *  component with only one of the pair set (a hand-edited half-config)
 *  is treated as unset rather than guessed at — the same "don't assume
 *  an ambiguous half-state" caution this codebase applies elsewhere. */
function seedProviders(
  env: Record<string, string>,
  sharedProvider: LlmProvider,
): { extraProviders: Partial<Record<LlmProvider, string>>; providerOverrides: Partial<Record<LlmComponent, LlmProvider>> } {
  const extraProviders: Partial<Record<LlmProvider, string>> = {}
  const providerOverrides: Partial<Record<LlmComponent, LlmProvider>> = {}
  for (const component of LLM_COMPONENTS) {
    const rawProvider = env[componentProviderVar(component)]
    const apiKey = env[componentApiKeyVar(component)]
    if (!rawProvider || !apiKey) continue
    if (!LLM_PROVIDERS.includes(rawProvider as LlmProvider)) continue
    const provider = rawProvider as LlmProvider
    providerOverrides[component] = provider
    if (provider !== sharedProvider) extraProviders[provider] = apiKey
  }
  // specs/132 — the registered-provider key store; a provider used by no
  // row is still registered on reopen.
  for (const provider of LLM_PROVIDERS) {
    const key = env[providerKeyVar(provider)]?.trim()
    if (key && provider !== sharedProvider && !extraProviders[provider]) extraProviders[provider] = key
  }
  return { extraProviders, providerOverrides }
}

/** Pre-fills from a previously saved config exactly as the classic wizard's
 *  own pre-fill does, including specs/034's rule that a saved
 *  ORCHESTRAI_ONLY may contain orchestrator/mcp:http from an older wizard
 *  and those must never be shown as if they were an agent choice. */
export function initialFormState(
  targetDirDefault: string,
  allAgents: string[],
  existing: ExistingConfigSeed = { env: {} },
): InitFormState {
  const savedOnly = (existing.env.ORCHESTRAI_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "orchestrator" && s !== "mcp:http")

  const provider = LLM_PROVIDERS.includes(existing.env.ORCHESTRAI_LLM_PROVIDER as LlmProvider)
    ? (existing.env.ORCHESTRAI_LLM_PROVIDER as LlmProvider)
    : "anthropic"

  const { extraProviders, providerOverrides } = seedProviders(existing.env, provider)

  return {
    targetPath: existing.projectPath || targetDirDefault,
    allAgents,
    // No saved subset means "all", which the form shows as everything ticked.
    selectedAgents: savedOnly.length > 0 ? allAgents.filter((n) => savedOnly.includes(n)) : [...allAgents],
    // specs/070 — no `agentLlm` field any more: a selected agent runs its
    // LLM path, full stop (formStateToWizardConfig derives the =1 lines
    // from the selection). A pre-070 config's ORCHESTRAI_<AGENT>_LLM_HARNESS
    // lines are simply not re-read here — re-running init makes every
    // selected agent an LLM agent, which is the new model.
    llmProvider: provider,
    llmModel: existing.env.ORCHESTRAI_LLM_MODEL ?? "",
    llmApiKey: existing.env.ORCHESTRAI_LLM_API_KEY ?? existing.env[providerKeyVar(provider)] ?? "",
    // specs/068 — the form opens on the Providers screen (step 1: register
    // the keys you have), not the setup screen. The `p`-key detour from
    // setup still reaches the same view; only the starting point moved.
    view: "providers",
    modelOverrides: seedModelOverrides(existing.env),
    // specs/071 — row 0 of the Models section, i.e. "shared / default".
    modelsCursor: 0,
    modelPickerOpen: false,
    modelPickerCursor: 0,
    extraProviders,
    providersCursor: 0,
    providerOverrides,
    discoveredModels: {},
    modelFetchStatus: {},
    modelFetchError: {},
    focus: "targetPath",
    agentCursor: 0,
    portOverrides: seedPortOverrides(existing.env),
    portsCursor: 0,
    harnessLimitOverride: seedHarnessLimitOverride(existing.env),
  }
}

// ============================================================
// Outcome
// ============================================================

/** What `init` did. specs/048 §4: the wizard previously returned void for
 *  both the written and cancelled paths, which made a structured outcome
 *  inexpressible. specs/122 removed the third variant, `"started"` —
 *  same-session launch (chdir + main() inside dispatch()) was a confirmed
 *  crash/hang on a real terminal, never a working code path — so `init`
 *  can now only ever save a config or be cancelled; it never launches
 *  anything itself. */
export type InitOutcome =
  | { outcome: "saved"; targetPath: string }
  | { outcome: "cancelled" }

// ============================================================
// Auto-scroll
// ============================================================

// The exact row each field starts at inside the scrollable fields region,
// matching apps/supervisor/init-form.tsx's own render order one-for-one:
// the agent list (header + 5 rows + note = 7 rows), a blank spacer, then
// specs/071's Models section. Kept as a pure, tested function rather than
// inline math in the renderer so a future reorder of the JSX has one
// obvious place to update, and a test that catches drift instead of
// silent mis-scrolling.
const BLANK_AFTER_AGENTS = 1

// specs/125-configurable-harness-recursion-limit/spec.md — the Ports
// section's own real (fixed) row count: header(1) + one row per
// SERVICE_PORT_ROWS entry. Unlike Models, this never varies with the
// agent selection, so it needs no parameter — but it DOES need to be
// real now that "harnessLimit" renders after it: while Ports was the
// last field, the loop below's generic "1 row" fallback for it was
// never actually exercised (nothing scrolled past it), so that
// approximation was harmless; it would silently mis-scroll now.
const PORTS_SECTION_ROWS = 1 + SERVICE_PORT_ROWS.length

/** `modelsRowCount` is the Models section's own real row count while it
 *  is NOT focused (header(1) + `modelsRows(state).length`) — the only
 *  shape that matters for scrolling PAST it to reach a later field,
 *  since its hint/picker lines only ever render while it IS focused
 *  (specs/073 confirmed: a Models-row picker claims every key ahead of
 *  the generic Tab handler, so focus can never leave "models" while the
 *  picker is open — by the time another field can be focused, the
 *  Models section has already collapsed back to just its header + rows). */
export function fieldScrollOffset(field: FormFieldId, agentCount: number, visible: FormFieldId[], modelsRowCount = 1): number {
  const agentSectionRows = 2 + agentCount // header(1) + N rows + note(1)
  if (field === "agents") return 0
  if (field === "targetPath") return 0 // never inside the scrollable region

  // The rows below the agent list are whatever's left in `visible` after
  // "agents" — "models", "ports", then "harnessLimit" as of specs/125 —
  // but deriving the offset from that list (rather than hardcoded
  // indices) is what keeps this in step with visibleFields() if it ever
  // grows again. Each section is separated from the next by one blank
  // spacer row (BLANK_AFTER_AGENTS, reused here for that general
  // purpose); "models" and "ports" each additionally contribute their
  // own real row count rather than a fixed 1 (models varies with the
  // agent selection; ports is fixed but multi-row). "harnessLimit" is
  // genuinely a single row, so the generic fallback of 1 is correct for
  // it (and for any future single-row field appended after it).
  const rows = visible.filter((f) => f !== "targetPath" && f !== "agents")
  const index = rows.indexOf(field)
  if (index === -1) return 0
  let offset = agentSectionRows + BLANK_AFTER_AGENTS
  for (let i = 0; i < index; i++) {
    if (rows[i] === "models") offset += modelsRowCount + BLANK_AFTER_AGENTS
    else if (rows[i] === "ports") offset += PORTS_SECTION_ROWS + BLANK_AFTER_AGENTS
    else offset += 1
  }
  return offset
}
