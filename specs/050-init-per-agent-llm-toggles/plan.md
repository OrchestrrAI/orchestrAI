# Plan: Init — Per-Agent LLM Toggles and Non-Destructive Config Writes

> Depends on `spec.md` in this directory being **approved** first. This plan
> cannot broaden it.

## Why this has a plan at all

Two of the three touched areas have already produced real, live-caught bugs
in this exact session: the form's layout row budget (five separate bugs
across `specs/048` Phases 2–5 and the real-terminal round after it), and
the config writer (whose full-overwrite behavior is the §2 bug this spec
fixes). Neither is a place to make a change and assume it worked.

## Phase 1 — Pure state and the config contract

1. `WizardConfig` gains `devopsLlm`, `documentationLlm`, `securityLlm`
   (booleans). `formatConfigEnv()` emits all three as `1`/`0`, always —
   matching how the two existing harness flags are written.
2. `InitFormState` gains the same three. `visibleFields()` shows each only
   when its agent is in the effective selection (empty `ORCHESTRAI_ONLY`
   = all agents = all three visible). `moveFocus()` skips hidden ones, as
   it already does for the provider block.
3. `initialFormState()` pre-fills each from the existing env, `=== "1"`.
4. `formStateToWizardConfig()` maps them across.
5. Extend `specs/048`'s byte-identical contract test to cover the three
   new flags in both directions.

**Exit gate:** every existing test still passes unmodified; the contract
test covers the new flags; a first-run write with all three off is
byte-identical to pre-050 output for the same answers.

## Phase 2 — Non-destructive `writeWizardConfig()`

1. Add an explicit `WIZARD_OWNED_KEYS` constant listing exactly the keys
   `formatConfigEnv()` emits. Derive it next to that function so the two
   cannot drift silently.
2. `writeWizardConfig()` reads the existing file when present, walks it
   line by line, replaces owned keys in place, drops owned keys no longer
   emitted, preserves everything else verbatim (comments, blanks, unknown
   keys, their order), and appends any newly-emitted owned key not already
   present.
3. Absent file → byte-identical to `formatConfigEnv()` today.

**Exit gate:** focused tests for each case above against real file content,
including a file containing `ORCHESTRAI_DEVOPS_LLM_MODEL`, a `#` comment,
a blank line, and an unrelated variable — all still present afterward.

**Stop condition:** if preserving *position* turns out to require parsing
beyond the tolerant `KEY=value` shape `parseConfigEnv()` already assumes,
stop and return — do not invent an escaping/quoting format.

## Phase 3 — Rendering

1. Three `ToggleRow`s inside the existing `<scrollbox>`, after the two
   existing toggles.
2. `fieldScrollOffset()` updated to match the renderer's real field order
   exactly, with tests — it is a pure mirror of the JSX and silently wrong
   if they drift.
3. Review-line summary of enabled harnesses, bounded like every other line.

**Exit gate:** PTY capture at 80×24 showing all toggles present, reachable
by Tab, auto-scrolled into view, with no row corruption, no padding loss,
and no overflow. Both 80×24 and a larger size, since the real-terminal
round found bugs visible at one and not the other.

**Stop conditions** (all inherited from `specs/048`, all live-proven
there): no explicit width/height on the outermost box; no `flexGrow`
scrollbox; no emoji anywhere inside a bordered box; no OpenTUI `title`
prop; every added line bounded, never left to wrap.

## Phase 3a — The Models view

1. `packages/shared/llm-model-factory.ts`: add
   `export const LLM_COMPONENTS = [...] as const` and derive
   `LlmComponent` from it. Nothing else in that file changes.
   `bun run typecheck` passing with every existing call site untouched is
   the proof this is behavior-neutral.
2. Pure state first, in `init-form-state.ts`: the override map, a
   `view: "setup" | "models"` field, focus movement within the models
   list, and set/clear semantics (empty string means "shared", never a
   materialised copy). Tested before any JSX exists.
3. `init-form.tsx`: `m` switches view; the Models view is an **early
   return** before the main form's JSX, exactly like the too-small-
   terminal branch already is — so it contributes zero rows to
   `CHROME_ABOVE`/`CHROME_BELOW`, which must come out of this phase
   unchanged.
4. `Esc` returns to setup with all state intact (not a cancel).

**Exit gate:** the main form's row-budget constants are untouched
(diffable proof); PTY captures of the Models view at 80×24 and a larger
size; a real edit round-trip — open, type a model for one component, Esc,
`^S`, and read the written file.

**Stop conditions:** same layout list as Phase 3. Additionally: if `m`
turns out to collide with an existing key binding on the setup form,
stop and pick another key rather than silently rebinding something.

## Phase 4 — Classic wizard parity

Three more y/n prompts, defaulting from the existing config, asked only
when the agent is in the selection. Same order as the form.

**Exit gate:** a non-TTY piped run writes the same bytes the form does for
equivalent answers, proven by the contract test plus one real piped run.

## Phase 5 — Verification and documentation

1. Full gates: `bun test`, `bun run typecheck`, `bun run specs:check`,
   `bun run build`.
2. One live `^S` launch with `Documentation LLM` on **and** a
   per-component model set for it, confirming that agent's own startup
   line reports the harness enabled and names
   `ORCHESTRAI_DOCUMENTATION_LLM_MODEL` as the source — both the flag and
   the override reaching the real process, not just the file.
3. `CLAUDE.md` / `README.md` / `context/worklog.md`.
4. `verification.md` recording evidence, harness-proven and Yusuf-proven
   kept visibly separate, as every prior checkpoint does.

**Exit gate:** the config a fresh `init` writes with all five harness
toggles on starts a stack where each of those five components reports its
own harness enabled at startup.

## Stop Conditions (whole plan)

Return for review if implementation would require: per-component
**provider or API key** configuration in either surface; changing LLM
resolution semantics or the component set itself; changing any agent's
harness behavior, tool access, or fail-open/fail-closed semantics; a new
dependency; a config file format beyond `KEY=value`; changing `main()`'s
startup sequence; or touching the approval gate.

If this plan's guidance turns out stale against the real code (line
numbers and helper names shift), re-verify the specific claim against the
file rather than following it blindly.
