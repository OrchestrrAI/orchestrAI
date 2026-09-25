# Verification: Init — Per-Agent LLM Toggles, Model Overrides, and Non-Destructive Config Writes

Result: **verified** for everything the PTY harness and real processes can
establish. The one item left to Yusuf is the same one every TUI checkpoint
in this repo leaves to him — a real terminal, not this synthetic harness.

Automated gates at completion: `bun test` **732/732** (from 695 at the
start of this spec), `bun run typecheck` 0 errors, `bun run specs:check`
clean, `bun run build` succeeded (141.0 MB).

## Phase 1 — per-agent gates in state and both surfaces

`AGENT_LLM_HARNESSES` (`init-wizard.ts`) is the one table mapping agent
name → field id → written variable → label. Each variable was verified
against the agent's own `model-factory.ts` (all three at line 29) rather
than assumed. The Testing Agent is absent because it genuinely has no
harness — no flag, no `model-factory.ts`.

**Two real problems, both found while implementing rather than after:**

1. **A gap of my own making.** Enabling only an agent gate would never
   have revealed the provider/model/key fields, writing a config whose
   agent then fails closed at startup with "…HARNESS=1 is set but
   ORCHESTRAI_LLM_API_KEY is missing". `needsProvider()` and the classic
   wizard's matching condition now count the per-agent gates. Confirmed
   live: harness and supervisor both off, DevOps LLM on, and the wizard
   reached its provider prompt.
2. **The contract test caught its own helper.** With a gate on, a
   provider line is now legitimately written; the helper omitted it and
   the test failed. Exactly what that test exists for — fixed in the
   helper, not papered over.

**Deviation from `plan.md`, stated rather than silent:** the classic
wizard's three prompts landed in Phase 1, not Phase 4. Phase 1's own exit
gate requires the byte-identical contract test to cover the new flags "in
both directions", which is only meaningful if the wizard side is real —
otherwise the test asserts a contract nothing honours. Phase 4 became
live parity verification instead.

**One acceptance criterion was corrected, not reinterpreted.** As first
written it demanded output "byte-identical to pre-050", which contradicts
this spec's own required behavior of always writing the gates as `1`/`0`.
The meaningful property — a config expressing *no* gates serializes
byte-identically, and pre-050 keys keep their exact content and order —
is what is implemented and tested.

**Live:** a non-TTY wizard round-trip wrote exactly the expected file;
starting the real DevOps agent against it printed
`LLM harness: enabled — provider gemini (ORCHESTRAI_LLM_PROVIDER)…`.

## Phase 2 — non-destructive config writes

The bug, pre-existing since `specs/031` and found while grounding this
spec: `writeWizardConfig()` wrote `formatConfigEnv()`'s output directly, a
full overwrite of a file built from a fixed line list. Every hand-added
line was silently deleted on the next confirmed `init` run.

`mergeConfigEnv()` replaces owned keys in place (keeping position),
removes owned keys no longer written, preserves comments/blanks/unknown
variables verbatim, appends newly written owned keys, and collapses a
duplicated owned key to one. `WIZARD_OWNED_KEYS` defines what may be
touched; its per-agent half is derived from the table, and a test asserts
the hand-listed half still covers everything `formatConfigEnv` emits — a
key missing from that list would be preserved stale forever.

**Live, on real files:** ran `init`, hand-added a comment and two
per-component overrides, re-ran `init` changing an answer — all preserved,
the changed gate flipped in place, the newly-needed provider block
appended. A third identical run produced a byte-identical file.

## Phase 3 — rendering

Three `ToggleRow`s built from the same table, gated on the same
`visibleFields()` the focus ring walks. `fieldScrollOffset()` now derives
each row from the visible list rather than a fixed ladder — it had to,
since the section's length varies with the agent selection.

The review line gained the enabled-harness summary and, in doing so, lost
a latent overflow: it previously interpolated the full target path
unbounded, the exact class of bug `specs/048` hit twice live. The path was
redundant (already shown in its own box three rows up), so the line is now
`.orchestrai\config.env · agents: … · LLM: …` with the harness list given
whatever width is free.

**Live at 80×24 against the compiled binary:** gates render and align, Tab
auto-scrolls to them, Space toggles DevOps LLM on and reveals the provider
block, the review line reads `LLM: all off` at boot and
`LLM: devops, documentation` after enabling two. Worst case checked
deterministically by seeding all five on — truncates to
`planning, orchestrator, devop…` on one row, no wrap, layout intact.

## Phase 3a — the Models view

`m` opens a full-screen view (an early return beside the too-small-terminal
branch) listing the shared provider and model, then one row per component.
It contributes **nothing** to the setup form's row budget — its
`CHROME_ABOVE`/`CHROME_BELOW` come out of this phase untouched, which is
why the pattern was chosen over inline fields on an already-scrolling
screen.

`LLM_COMPONENTS` is now an exported `as const` with `LlmComponent` derived
from it. Typecheck passing with every existing
`readLlmModelConfig(env, "…")` call site unchanged is the proof that
change is behavior-neutral.

`componentModelVar()` builds the variable name the same way
`resolveLlmVar()` does, pinned by a test: if those two ever diverged the
override would silently do nothing, the worst failure available here.

**A consequence worth stating plainly:** `WIZARD_OWNED_KEYS` now owns the
per-component model variables, so merge removes any the config does not
express — that is what makes clearing a row genuinely delete its line. It
also means seeding is load-bearing: a hand-edited override survives only
because `initialFormState()` reads it back. Two Phase 2 tests used those
variables as their "unknown key" example and correctly began failing; they
now use a genuinely foreign key, and a round-trip test pins the real
preservation path directly.

**Live at 80×24:** `m` opened the view, arrows reached the orchestrator
row, typing set `gemini-3.5-pro`, `Esc` returned to setup with state
intact, `^X` wrote exactly one override line and nothing for the other
five. Then the decisive check — starting the real orchestrator against
that file:

```
plan-task planner: enabled (default) — provider gemini (ORCHESTRAI_LLM_PROVIDER),
model gemini-3.5-pro (ORCHESTRAI_ORCHESTRATOR_LLM_MODEL),
key from ORCHESTRAI_LLM_API_KEY
```

The override reached the real process; provider and key still resolved
from the shared variables. That is `specs/039`'s per-field fallback
working end to end from UI to file to running component.

## Phase 4 — classic wizard parity, live

Both surfaces run for real against the compiled binary, with answers the
wizard can express (no per-component models, no API key, provider left at
the form's default), each in its own fresh directory:

- Form: Tab ×4 to the DevOps gate, Space, `^X`.
- Wizard: `init --classic` with the equivalent piped answers.

`diff` of the two written `config.env` files: **byte-identical**. Not a
unit-test claim about the contract — two real runs of the shipped binary.

## Phase 5 — end to end, and one more live fix

The spec's own end-to-end criterion, exercised across both surfaces in
sequence: the classic wizard wrote a config with the Documentation harness
on plus a shared model and key; the form then opened on that existing
config (correctly seeded — harness still on, key preserved), added a
Documentation model override through the Models view, and saved. Starting
the real agent against the result:

```
[documentation-agent] LLM harness: enabled — provider gemini (ORCHESTRAI_LLM_PROVIDER),
model gemini-3.5-pro (ORCHESTRAI_DOCUMENTATION_LLM_MODEL),
key from ORCHESTRAI_LLM_API_KEY
```

Both the gate and the override reach the real process. No API call is
needed for this: the startup line reports resolved configuration and names
the variable each value came from.

**One cosmetic bug that run exposed and fixed:** merge kept the existing
file's own trailing newline as a blank line and appended new keys after
it, stranding a gap mid-file. Trailing blanks are now trimmed *before*
appending, with a test. Repeated runs were already stable and still are.

## Left to Yusuf

A real terminal, for the same reasons every prior TUI checkpoint here
records: the `m`/`Esc` round trip and typing into a model row under real
keyboard timing, and whether the `specs/048` TUI-auto-launch finding (open
in that spec, unrelated to this one) still reproduces. Everything above ran
through `node-pty`'s ConPTY wrapper, which this repo has never treated as a
substitute for that.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/050-init-per-agent-llm-toggles/spec.md` (implemented; amends 031
and 048) closes the gap that `init` could enable only **two** of the five
real LLM gates in this runtime. Both surfaces now ask about DevOps
(`specs/042`), Documentation (`specs/041`) and Security (`specs/043`)
too, writing their real
`ORCHESTRAI_{DEVOPS,DOCUMENTATION,SECURITY}_LLM_HARNESS` variables.
`AGENT_LLM_HARNESSES` (`apps/supervisor/init-wizard.ts`) is the single
table mapping agent name → field → written variable → label, so the
serializer, the form's pure state and both UIs cannot drift; the Testing
Agent is deliberately absent (it has no harness), and Planning kept the
original un-prefixed `ORCHESTRAI_LLM_HARNESS` at the time this spec was
written — dead along with Planning Agent itself as of `specs/051`, see
"Planning Agent (retired)" above. A gate is offered and
written only for an agent that is actually in the service selection.
Enabling **any** harness — including an agent gate on its own — now
reveals the provider/model/key questions, closing a real gap where such a
config would have been written with no credentials and failed closed at
runtime.

The form additionally gains a **Models view** (`m` from the setup screen,
`Esc` back) exposing `specs/039`'s per-component model overrides, which
were fully implemented in the runtime and unreachable from `init`. Each
of the six components (`LLM_COMPONENTS` in
`packages/shared/llm-model-factory.ts`, now an `as const` array with
`LlmComponent` derived from it) shows its own model or `(shared)`; a
non-empty row writes `ORCHESTRAI_<COMPONENT>_LLM_MODEL`, an empty one
writes nothing so the shared model keeps applying, matching
`resolveLlmVar()`'s own per-field fallback. Per-component **provider and
API key** stayed deliberately unexposed here: a per-component provider
without a matching key would silently fall back to the shared key
belonging to a different provider, surfacing as a confusing auth error
at call time rather than at configuration time. **Correction —
`specs/063` below closes exactly this gap**, named at the time as "a
candidate follow-up rather than silently omitted."

Hand-editing is now safe for the first time. `writeWizardConfig()` used
to write `formatConfigEnv()`'s output directly — a full overwrite that
silently deleted every line the wizard did not itself produce, on every
confirmed re-run since `specs/031`. It now merges: `WIZARD_OWNED_KEYS`
lines are replaced in place or removed when no longer written, and
comments, blank lines and unknown variables survive verbatim. Live-proven
on real files, including that a third identical run is byte-identical.
Note the consequence: the per-component model variables **are** owned
now, so a hand-edited override survives because `initialFormState()`
seeds it back, not because merge treats it as foreign.
