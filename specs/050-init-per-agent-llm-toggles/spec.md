---
id: 050-init-per-agent-llm-toggles
title: Init — Per-Agent LLM Toggles, Model Overrides, and Non-Destructive Config Writes
area: supervisor
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-04
updated: 2026-09-05
approved_by: Yusuf
approved_on: 2026-09-04
implemented_on: 2026-09-05
amends:
  - 031-interactive-init-wizard
  - 048-guided-init-experience
supersedes: []
superseded_by: []
related:
  - 034-init-wizard-services-ux
  - 038-supervisor-default-and-planning-retirement
  - 039-per-component-llm-provider-config
  - 041-llm-harness-documentation
  - 042-llm-harness-devops
  - 043-llm-harness-security
---

# Spec: Init — Per-Agent LLM Toggles, Model Overrides, and Non-Destructive Config Writes

> Review gate: **APPROVED by Yusuf, 2026-09-04.** Implementation follows
> `plan.md`'s phases; each phase's exit gate must pass before the next.

## Purpose

Three agents have a real, implemented, live-verified LLM harness that
`orchestrai init` cannot enable: DevOps (`specs/042`), Documentation
(`specs/041`), and Security (`specs/043`). Separately, `specs/039`'s
per-component model overrides are fully implemented in the runtime and
completely unreachable from init — every component is stuck on one shared
model unless the file is hand-edited. And hand-editing is currently
**unsafe**, because re-running init silently destroys every line it does
not own (§2).

This checkpoint closes all three gaps: a toggle per harness-capable agent,
a dedicated Models view for per-component model overrides, and a config
writer that stops throwing away keys it doesn't recognise.

## Verified Current State

Read directly from the repository on 2026-09-04, not assumed:

1. **Six components can use an LLM, not two.**
   `packages/shared/llm-model-factory.ts` line 15 defines the closed set:
   `"planning" | "orchestrator" | "documentation" | "devops" | "security" |
   "conversation"`. Each resolves `ORCHESTRAI_<COMPONENT>_LLM_<FIELD>`
   first and falls back **per field** to the shared `ORCHESTRAI_LLM_<FIELD>`
   (`resolveLlmVar()`), exactly as `specs/039` specifies. Per-component
   provider/model/key overrides are therefore **already fully implemented
   in the runtime** — they are simply unreachable from init.

2. **Each agent's harness gate is its own flag**, confirmed in each
   agent's own `model-factory.ts`:
   - `ORCHESTRAI_DEVOPS_LLM_HARNESS === "1"`
     (`packages/agents/devops/model-factory.ts:29`)
   - `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS === "1"`
     (`packages/agents/documentation/model-factory.ts:29`)
   - `ORCHESTRAI_SECURITY_LLM_HARNESS === "1"`
     (`packages/agents/security/model-factory.ts:29`)
   Planning's own harness is the original un-prefixed
   `ORCHESTRAI_LLM_HARNESS` (`packages/agents/planning/index.ts:115`), and
   the Orchestrator's supervisor is key-gated with
   `ORCHESTRAI_ORCHESTRATOR_GRAPH` as an opt-out (`specs/038` Phase 1).
   **The Testing Agent has no LLM harness at all** — no flag, no
   `model-factory.ts`, nothing to expose.

3. **`init` writes exactly six lines and can express only two of the five
   gates.** `formatConfigEnv()` (`apps/supervisor/init-wizard.ts:106-116`)
   emits `ORCHESTRAI_ONLY`, `ORCHESTRAI_LLM_HARNESS`,
   `ORCHESTRAI_ORCHESTRATOR_GRAPH`, and optionally
   `ORCHESTRAI_LLM_PROVIDER` / `_MODEL` / `_API_KEY`. The three per-agent
   harness flags in (2) are absent from `WizardConfig`
   (`init-wizard.ts:30-42`), from the form's `InitFormState`
   (`init-form-state.ts`), and from both UIs.

4. **A real data-loss bug, found while grounding this spec.**
   `writeWizardConfig()` (`init-wizard.ts:209-215`) calls
   `writeFileSync(envPath, formatConfigEnv(config))` — a **full
   overwrite**. `formatConfigEnv()` builds the file from a fixed list of
   lines and never consults anything else. `readExistingWizardConfig()`
   parses every key present, but `initialFormState()` /
   `formStateToWizardConfig()` only ever carry the known ones. So **any
   line a user added by hand — `ORCHESTRAI_DEVOPS_LLM_HARNESS=1`,
   `ORCHESTRAI_ORCHESTRATOR_LLM_MODEL=…`, a comment, anything — is
   silently deleted the next time `init` is run and confirmed.** This is
   pre-existing (it dates to `specs/031`), harmless while the file only
   ever held six wizard-owned keys, and becomes a genuine trap the moment
   this checkpoint tells people per-component configuration exists.

5. **The component list is a type, not data.**
   `LlmComponent` (`llm-model-factory.ts:15`) is a bare type union with no
   runtime array — nothing can currently enumerate the six components to
   render a row per component. Confirmed: the file exports no `const`
   at all.

6. **Every agent really does pass its own component name**, so
   per-component overrides genuinely reach each one — verified in each
   `model-factory.ts:35-38`: `readLlmModelConfig(env, "devops")`,
   `"documentation"`, `"security"`, `"planning"`. Resolution is per field
   (`resolveLlmVar()`): a component-specific var wins only when set and
   non-empty, otherwise the shared `ORCHESTRAI_LLM_<FIELD>` is used. So
   overriding only the model while sharing one key already works today —
   it is purely a discoverability and safety problem, not a runtime one.

## Proposed Behavior

### 1. Three new toggles, one per harness-capable agent

Both `orchestrai init` surfaces gain three independent on/off toggles
beside the two that exist today:

| Toggle label | Writes | Effect when on |
|---|---|---|
| `DevOps LLM` | `ORCHESTRAI_DEVOPS_LLM_HARNESS` | LLM picks the *parameters* for DevOps's four write skills; the templates themselves are untouched (`specs/042`) |
| `Documentation LLM` | `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS` | LLM writes real README / API-doc content (`specs/041`) |
| `Security LLM` | `ORCHESTRAI_SECURITY_LLM_HARNESS` | LLM adds commentary beside the unchanged deterministic findings (`specs/043`) |

Written as `1`/`0` on every write, matching how `ORCHESTRAI_LLM_HARNESS`
and `ORCHESTRAI_ORCHESTRATOR_GRAPH` are already written — never omitted
when off, so a re-run's pre-fill is unambiguous.

**Visibility follows the agent selection.** A toggle is only shown, and
only written, when its agent is in the effective service selection — the
same reasoning `visibleFields()` already applies to the provider/model/key
block. An empty `ORCHESTRAI_ONLY` means "all agents", so all three show by
default. Deselecting `security-agent` hides and clears its toggle rather
than persisting a flag for a process that will not start.

### 1a. A dedicated Models view for per-component overrides

`m` from the setup form opens a **full-screen Models view**; `Esc`
returns. It lists the shared provider and model, then one row per
component (`planning`, `orchestrator`, `devops`, `documentation`,
`security`, `conversation`), each showing either its own model or
`(shared)`. `Tab`/arrows move, `Enter` edits inline (the same hand-rolled
buffer technique the target-path and model fields already use), clearing
a row back to empty restores `(shared)`.

Each non-empty row writes `ORCHESTRAI_<COMPONENT>_LLM_MODEL`; an empty
row writes nothing at all, so the shared value keeps applying — matching
`resolveLlmVar()`'s own per-field fallback exactly, rather than
materialising six copies of the same value.

**Full-screen, not extra rows on the main form** — this is load-bearing,
not cosmetic. The main form already scrolls at the 80×24 minimum, and
`specs/012`'s help view and `specs/046`'s chat view both established the
early-return full-screen pattern in this codebase for exactly this
reason: a view that replaces the screen adds **nothing** to the row
budget the `specs/048` work spent five separate live-caught bugs getting
right. The Models view inherits every one of those layout constraints.

**Deliberately models only — not provider or key per component.** The
runtime supports `ORCHESTRAI_<COMPONENT>_LLM_PROVIDER` and `_API_KEY`
too, but exposing a per-component *provider* without a per-component
*key* would be actively harmful: the key would fall back to the shared
one, which belongs to a different provider, and the failure would surface
as a confusing auth error at call time rather than at configuration time.
Offering both would mean running `specs/048`'s masked-key handoff up to
six times and holding six secrets in form state. Per-component
provider/key therefore stay hand-edited — safely, for the first time,
under §2 — and are called out as a candidate follow-up rather than
silently omitted. The common case this view serves is one provider, one
key, different model tiers per component (a cheap model for DevOps
parameter-picking, a stronger one for the Orchestrator's supervisor).

To make the six components enumerable, `llm-model-factory.ts` gains
`export const LLM_COMPONENTS = [...] as const` with `LlmComponent`
derived from it (`(typeof LLM_COMPONENTS)[number]`) — the exact idiom
`LLM_PROVIDERS`/`LlmProvider` already uses in `init-wizard.ts`. Same six
names, same order, zero behavior change; it only makes the existing
closed set readable at runtime instead of hand-copying it and needing a
drift test.

### 2. Config writes stop destroying unknown keys

`writeWizardConfig()` merges instead of overwriting: it reads the existing
`config.env` (when present), and preserves every line whose key is not one
this writer owns. Wizard-owned keys are replaced with the new values;
unknown keys keep their existing value **and their position** in the file.
Comments and blank lines are preserved.

The set of "owned" keys is defined in code as an explicit constant, not
inferred — so adding a key to `formatConfigEnv()` in future automatically
makes it owned, and never silently starts preserving a stale copy of it.

A file that does not exist yet produces byte-identical output to today's
`formatConfigEnv()`, so the first-run path is provably unchanged.

### 3. The form's review line reflects what will actually run

The always-visible footer summary gains a compact count of enabled
harnesses (e.g. `LLM: planning, devops, security`) so `^S` is never a
surprise. Bounded like every other line in that form, per `specs/048`.

## Scope

- `packages/shared/llm-model-factory.ts` — add `LLM_COMPONENTS` as an
  exported `as const` array and derive the existing `LlmComponent` type
  from it. No new component, no resolution change.
- `apps/supervisor/init-wizard.ts` — `WizardConfig` gains three booleans
  plus a per-component model map; `formatConfigEnv()` emits the three
  flags and any non-empty model overrides; `writeWizardConfig()` merges
  rather than overwrites; the classic wizard asks three more y/n
  questions (per-component models stay form-only there, see Non-Goals).
- `apps/supervisor/init-form-state.ts` — three toggle fields, the model
  override map, `visibleFields()`/`moveFocus()` awareness,
  `initialFormState()` pre-fill, `formStateToWizardConfig()` mapping,
  `fieldScrollOffset()` row math, and pure focus/edit helpers for the
  Models view.
- `apps/supervisor/init-form.tsx` — three `ToggleRow`s inside the existing
  scrollbox; the `m` key; the full-screen Models view as an early return;
  review-line summary.
- Tests alongside each of the above.
- `CLAUDE.md` and `README.md` where they describe what `init` can
  configure.

## Safety and Compatibility Constraints

- **No change to any agent's own harness behavior.** This checkpoint only
  writes flags those agents already read. `specs/041`/`042`/`043` are
  untouched — no new tool access, no change to fail-closed/fail-open
  semantics, no change to what any harness may do.
- **The approval gate is untouched.** DevOps's and Documentation's write
  skills still stop for human approval regardless of who chose their
  parameters or content.
- **The one config contract holds.** `specs/048`'s byte-identical test
  (form output === classic wizard output for equivalent answers) must
  still pass, extended to cover the three new flags.
- **No new secret is introduced.** The three flags are booleans. The
  single API key keeps `specs/031`'s existing plaintext-storage decision
  and its existing visible warning; nothing about key handling changes.
- **First-run output is byte-identical to today** when no prior
  `config.env` exists and all three new toggles are off.
- **No new dependency.**

## Out of Scope / Non-Goals

- A Testing Agent LLM toggle — that agent has no harness to gate.
- **Per-component provider and API key** — models only, for the
  footgun reason given in §1a. They remain hand-editable (safely, under
  §2) and are a candidate follow-up checkpoint, not a silent omission.
- Per-component models in the **classic wizard**. The form gets the
  Models view; the classic prompt flow keeps the shared model question
  only. Adding six more sequential prompts to a linear y/n flow is worse
  UX than the file it would replace, and the non-TTY path exists for
  scripting, where editing `config.env` directly is the natural move.
  The byte-identical contract still holds for everything the wizard *can*
  express.
- Any change to LLM resolution semantics. `LLM_COMPONENTS` only makes the
  existing closed union enumerable; `resolveLlmVar()`,
  `readLlmModelConfig()`, and the six component names are untouched.
- Retiring the Planning Agent, or changing when the supervisor is chosen
  over it — that remains `specs/038` Phase 2, still unapproved.
- The browser setup page (`specs/049`) — it must gain the same toggles
  when it is implemented, but this checkpoint does not implement it.
- The open `specs/048` TUI-auto-launch finding, which is tracked there.

## Acceptance Criteria

- [ ] Explicit approval is recorded before implementation.
- [ ] The form shows three new toggles; each writes its documented flag as
      `1`/`0`, verified by reading the real written file.
- [ ] A toggle is hidden and its flag omitted when its agent is not in the
      effective selection; all three show when `ORCHESTRAI_ONLY` is empty.
- [ ] The classic wizard asks the same three questions and produces
      **byte-identical** `config.env` output to the form for equivalent
      answers, where "equivalent" excludes per-component models the
      wizard cannot express (extends `specs/048`'s existing contract
      test).
- [ ] `m` opens the Models view; `Esc` returns to the form with state
      intact; the main form's own row budget is unchanged (its
      `CHROME_ABOVE`/`CHROME_BELOW` constants do not move).
- [ ] A model typed for one component writes exactly
      `ORCHESTRAI_<COMPONENT>_LLM_MODEL` and nothing for the others;
      clearing it back to empty removes the line entirely rather than
      writing the shared value.
- [ ] `LLM_COMPONENTS` and `LlmComponent` cannot drift — the type is
      derived from the array, asserted by `bun run typecheck` passing
      with every existing `readLlmModelConfig(env, "…")` call site
      unchanged.
- [ ] Re-running `init` against a `config.env` containing hand-added keys
      (`ORCHESTRAI_DEVOPS_LLM_MODEL`, a comment, an unrelated var)
      preserves all of them, with wizard-owned keys updated — asserted by
      a real test against real file content.
- [x] **Regression proof, clarified during Phase 1** — the criterion as
      first written ("output is byte-identical to pre-050 output")
      contradicted this spec's own Proposed Behavior, which requires the
      three gates to be written as `1`/`0` whenever their agent is
      selected: a default config now legitimately gains three lines. The
      meaningful, testable property, and the one implemented: a config
      expressing **no** per-agent gates (what every pre-050 caller
      produces) serializes byte-identically to before, and the pre-050
      keys keep their exact content and order in every case. Corrected
      rather than silently reinterpreted; behavior is unchanged from what
      was approved.
- [ ] A live run with `Documentation LLM` on produces a real
      `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=1`, and the started
      Documentation Agent's own startup line reports the harness enabled —
      end to end, not just the file.
- [ ] `bun test`, `bun run typecheck`, `bun run specs:check`,
      `bun run build` pass; the form renders cleanly at 80×24 with all
      toggles visible (PTY capture).
- [ ] `CLAUDE.md`, `README.md`, and `context/worklog.md` updated.

## Verification Plan

**Automated.** Unit tests for the three new state fields, their visibility
rules, and the extended byte-identical form-vs-wizard contract. A focused
merge test suite for `writeWizardConfig()`: unknown key preserved, comment
preserved, position preserved, owned key updated, absent-file case
byte-identical to today.

**Live, via the PTY harness** (`specs/047`/`048`'s `node-pty` +
`@xterm/headless` setup, scratch-only): the form at 80×24 with all
toggles shown and reachable by Tab; a real `^S` writing a real file with
the three flags; a re-run over a hand-edited file proving preservation.

**Live, end to end**: one `^S` launch with `Documentation LLM` on and a
per-component model set for it in the Models view, confirming the
Documentation Agent's own startup output reports both the harness enabled
**and** the model resolved from `ORCHESTRAI_DOCUMENTATION_LLM_MODEL` —
`describeLlmModelConfig()` already names which variable each value came
from, so this is directly observable. Proves the flag and the override
both reach the real process, not just the file. No real API call is
required; the startup line reports resolved configuration.

**Deliberately not claimed**: real-terminal confirmation, which stays
Yusuf's, per every prior TUI checkpoint in this repo.

## Approval Requested

Approval authorizes: adding three per-agent LLM harness toggles to both
`init` surfaces and the config writer; a full-screen Models view in the
form for per-component **model** overrides, backed by a new exported
`LLM_COMPONENTS` array; and making `writeWizardConfig()` non-destructive
to keys it does not own.

It does **not** authorize: per-component **provider or API key**
configuration in either surface, per-component models in the classic
wizard, any change to LLM resolution semantics or to the agents' own
harness behavior/tool access, a Testing Agent harness, `specs/038`
Phase 2, or implementing `specs/049`.
