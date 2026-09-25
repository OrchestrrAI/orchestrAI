# Verification — 072 Guided Init Forms: Empty Selection Means No Agents

Status: **partial** — every pure-state property is unit-tested, and the
resulting render (checkboxes, Models section, review line) is confirmed
live in a real PTY at 80×24 via a temporary state-injection technique
(not a genuine end-to-end keystroke-driven save). A real interactive
pass — untick every box by hand, save, inspect the written
`config.env` — needs Yusuf's raw-mode terminal.

## What changed

### 1. `selectedAgentsToOnly()` — empty means none

`apps/supervisor/init-form-state.ts`:
```ts
if (chosen.length === state.allAgents.length) return []       // all → unrestricted, unchanged
if (chosen.length === 0) return ["orchestrator"]              // none → orchestrator only, changed
return chosen
```
`formatConfigEnv()`'s existing "append `orchestrator` to any non-empty
`only` that doesn't already have it" rule needed no change —
`["orchestrator"]` already contains it, so it passes through untouched
to `ORCHESTRAI_ONLY=orchestrator`.

### 2. `agentLlmFieldsFor()` — no "empty means all" fallback

```ts
export function agentLlmFieldsFor(state): AgentLlmField[] {
  return AGENT_LLM_HARNESSES.filter((h) => state.selectedAgents.includes(h.agent)).map((h) => h.field)
}
```
A fresh form's `selectedAgents` default is the full explicit array
(`initialFormState()`), never `[]`, so this only changes the
deliberately-emptied case. `modelsRows()` and
`formStateToWizardConfig()`'s `agentLlm` derivation both already read
this one function, so both are fixed by this single change: an emptied
selection now shows only the `"shared"` Models row and writes no
`ORCHESTRAI_<AGENT>_LLM_HARNESS` lines.

### 3. The Agents checkboxes — reverted to plain rendering

`apps/supervisor/init-form.tsx`'s `AgentsSection` no longer has the
same-day `allSelected` fallback added for `specs/071`'s earlier
"checkboxes lied" fix — that fix made sense under the OLD "empty means
all" convention; under the NEW "empty means none" convention, a plain
`selectedAgents.includes(agent.name)` check is itself the honest
rendering again.

### 4. `ReviewLine`'s summary label

`count === 0` now renders `"none (orchestrator only)"` instead of
`"all"`, so `^S`/`^X` are never a surprise about what's about to start.

### 5. Classic wizard and browser form

Untouched, as scoped: `parseServiceSelection()` still treats blank input
as "all" (the genuinely ambiguous text-prompt case). `init-web.ts`
inherits the fix automatically (same `formStateToWizardConfig()`/
`agentLlmFieldsFor()`) with no code change of its own — its own
checkbox rendering never had the TUI form's same-day detour.

## Tests (`apps/supervisor/init-form-state.test.ts`)

- **selectedAgentsToOnly**: `[]` → `["orchestrator"]` now (was `[]`);
  full array → `[]` unchanged; a real subset unchanged.
- **New `agentLlmFieldsFor` describe block**: empty → `[]`; the fresh
  form's full array → unchanged (`["devopsLlm","documentationLlm",
  "securityLlm"]`); a real subset → just that subset's field.
- **Models section**: `modelsRows([])` → `["shared"]` (was
  `["shared","devops","documentation","security"]`).
- **specs/070 — agent selection IS the LLM decision**: the "nothing
  selected" test now asserts `agentLlm: {}` and `only: ["orchestrator"]`
  (was `{devopsLlm:true,...}`).
- **One config contract** tests: unaffected — none of them exercise an
  empty `selectedAgents`; the "all" cases all use the full explicit
  array, which this spec leaves unchanged.

## Suite

- `bun test` — 883 pass, 0 fail (net +3 from the new
  `agentLlmFieldsFor` describe block).
- `bun run typecheck` — 0 errors.
- `bun run specs:catalog` + `bun run specs:check` — pass, 71 specs.
- `bun run build` — **blocked**: `dist/bin/orchestrai.exe` locked
  (`EPERM`) by a running stack. Bundle step succeeded (1350 modules);
  needs a rebuild once the binary is free. Gitignored, no commit impact.

## Live smoke (real PTY, 80×24)

Same technique as `specs/069`/`070`/`071`'s own smokes: temporarily
forced `initialFormState()`'s `view` to `"setup"` and `selectedAgents`
to `[]` (reverted immediately after, confirmed via `git diff` back to
the committed state), then ran the real `runInitForm()` under this
environment's fixed-80×24 PTY:

```
[ ] documentation-agent   generate-readme, document-api
[ ] security-agent        scan-secrets, check-gitignore-coverage, audit-d…
  orchestrator and mcp:http are always included.

  Models  ↑↓ move · Enter pick provider + model
  shared / default      (pick from the list or type one)

.orchestrai\config.env  ·  agents: none (orchestrator only)  ·  Agent LLM:
none
```

Confirmed all three fixes at once: every Agents row renders `[ ]`
(dim, unchecked); the Models section shows only `shared / default`, no
agent rows; the footer reads "none (orchestrator only)" and "Agent LLM:
none" — no wrapped/corrupted lines at the 80×24 minimum.

## Live pass still owed (Yusuf's terminal)

1. In a real interactive run, individually untick every agent
   (Space on each), confirm the Models section and review line update
   live exactly as smoked above.
2. Save (`^S`/`^X`) and confirm the written `.orchestrai/config.env`
   contains `ORCHESTRAI_ONLY=orchestrator` and no
   `ORCHESTRAI_<AGENT>_LLM_HARNESS` lines.
3. Start from that config and confirm the supervisor genuinely starts
   only orchestrator + mcp:http (`GET /healthz` on each, no
   devops/testing/documentation/security processes) — this exercises
   `apps/supervisor/index.ts`'s already-existing `--only orchestrator`
   path, which this spec relies on but doesn't itself touch.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**A same-day correction to that checkpoint's own same-day checkbox fix:
`specs/072-init-form-empty-selection-means-no-agents/spec.md`
(implemented, `verification: partial`; amends `034`/`048`/`071`),
2026-09-11.** Yusuf, after watching the "all boxes unticked still shows
every Models row" bug get fixed: *"but why? even i select non means
non!"* — pushing back on the underlying convention itself, not just its
display. Every guided-init surface (`specs/034`/`048`) had always
treated an **empty** agent selection as **"all agents"**
(`selectedAgentsToOnly()` mapped both "everything ticked" and "nothing
ticked" to an unrestricted `only: []`), matching the classic wizard's
own "blank Enter = all" convention. That's the right call for a **text
prompt**, where blank input is genuinely ambiguous — but the
**checkbox** forms (TUI, browser) start with every box ticked, so the
*only* way their `selectedAgents` ever becomes `[]` is a user
individually unticking every single one — an unambiguous, deliberate
action. Confirmed via AskUserQuestion ("Yes — checkboxes only") that
this should mean **zero agents**, not "all", while the classic wizard's
own blank-input convention stays exactly as it was.
`selectedAgentsToOnly()` now writes `["orchestrator"]` (not `[]`) for an
explicitly empty selection — `formatConfigEnv()` needed no change,
since its existing "append `orchestrator` to a non-empty `only`" rule
already leaves that array untouched — landing on
`ORCHESTRAI_ONLY=orchestrator`, an **already-supported** supervisor mode
(`--only orchestrator`, orchestrator + mcp:http only, documented in
`apps/supervisor/index.ts`'s own `--help` text) that this spec makes
reachable from the form rather than inventing. `agentLlmFieldsFor()`
lost its own independent "empty means all" fallback — it's now a plain
membership filter — which automatically fixes both `modelsRows()`
(`specs/071` — an emptied selection now shows only the `"shared"` row)
and `formStateToWizardConfig()`'s `agentLlm` (now writes no
`ORCHESTRAI_<AGENT>_LLM_HARNESS` lines when nothing is selected), since
both already derived from that one function. **`specs/071`'s own
same-day `AgentsSection` checkbox fix is reverted** — under the *old*
convention, showing every box as checked when the array was empty was
the honest rendering; under the *new* one, a plain
`selectedAgents.includes(name)` check is honest again.
`ReviewLine`'s summary label now says `"none (orchestrator only)"`
instead of `"all"` when nothing is ticked. The classic wizard
(`parseServiceSelection`) and `apps/supervisor/index.ts` are both
untouched — the latter's `--only orchestrator` support already existed;
this spec only gives a guided-init form a way to reach it.
`bun test` 883 pass, typecheck clean, specs:check 71 specs.
Live-smoked in a real PTY at 80×24 (the same temporary state-injection
technique the other 069–071 smokes used, reverted immediately after):
with every box unticked, every Agents row renders `[ ]`, the Models
section shows only `shared / default`, and the footer reads "agents:
none (orchestrator only)". **Not verified**: a genuine keystroke-driven
untick-everything-and-save pass, and confirming the resulting supervisor
startup genuinely skips all four work agents — needs Yusuf's terminal.
