# Verification: 034 — Init Wizard Services Prompt

Status: `implemented`, `verification: verified` (2026-09-01 — the
zero-flag live-startup gap below was the sole remaining item and is now
closed).

## Automated

- `bun test apps/supervisor/init-wizard.test.ts` — 30 pass, 0 fail, 51
  expect() calls. Includes new cases: numbered-selection resolution
  (`"2,4"` → `["devops-agent", "documentation-agent"]`), a single number,
  an out-of-range number, garbage input, `mcp:http`/`orchestrator` no
  longer being valid tokens, `formatConfigEnv` always appending
  `orchestrator` to a non-empty `only[]`, no duplicate when it's already
  present, and the real-file round-trip (`writeWizardConfig` →
  `readExistingWizardConfig`) confirming the same on disk.
- `bun test` (full suite) — 307 pass, 0 fail, 550 expect() calls.
- `bun run typecheck` — 0 errors.
- `bun run specs:catalog` + `bun run specs:check` — clean for 34 specs.

## Live/manual

All three live runs below used `bun run apps/supervisor/index.ts` directly
against a disposable scratch directory
(`%TEMP%\claude\wizard-test`, deleted afterward), with piped stdin
(the wizard's own non-TTY fallback path, not the raw-mode TTY path).

1. **Numbered selection end to end.** Piped `2,4` at the "Services to
   run" prompt. Confirmed: the prompt lists only the 5 agents, numbered;
   `mcp:http`/`orchestrator` never appear; the resolved selection was
   `devops-agent, documentation-agent`; the confirm screen shows only
   those two (not `orchestrator`); the written `config.env` contains
   `ORCHESTRAI_ONLY=devops-agent,documentation-agent,orchestrator`.
2. **Pre-034 config compatibility.** Hand-wrote a `config.env` with
   `ORCHESTRAI_ONLY=devops-agent,security-agent` (no `orchestrator`) to
   simulate a save from before this checkpoint, then re-ran `init`
   against the same directory. The prompt's pre-filled default correctly
   showed `devops-agent,security-agent` — no crash, and `orchestrator`/
   `mcp:http` were never displayed as if they'd been a prior choice.
   Confirming with blank input re-saved
   `ORCHESTRAI_ONLY=devops-agent,security-agent,orchestrator`.
3. **Zero-flag startup — now exercised live (2026-09-01).** Ports were
   confirmed fully free this time (no conflicting session running), so
   this was no longer blocked. Built a scratch config precisely matching
   what the **fixed** wizard writes — `ORCHESTRAI_ONLY=planning-agent,
   devops-agent,orchestrator` (a non-empty subset with `orchestrator`
   explicitly appended, not the simpler "empty = unrestricted" case) — at
   `<scratch-dir>/.orchestrai/config.env`, plus the matching
   `orchestrai.project.txt`. Ran `bun run apps/supervisor/index.ts
   --headless` with **zero flags** from that directory (the real
   `cd my-app && orchestrai` shape). Result: project path resolved from
   the wizard's own project file (logged source:
   `.orchestrai\orchestrai.project.txt (orchestrai init)`); exactly the
   configured subset started, plus the existing `mcp:http` auto-include
   (unrelated to this checkpoint) since `devops-agent` needs it; **the
   orchestrator genuinely started** — startup summary showed all four
   services green (`mcp:http`, `planning-agent`, `devops-agent`,
   `orchestrator`), and `GET /healthz` against all four confirmed
   directly, not inferred from log text alone (DevOps's own healthz
   additionally confirmed its MCP connection state). No crash. Stopping
   the supervisor's own top-level process afterward left zero orphaned
   `bun` processes and all ports free — the same
   outcome-confirmed/exact-signal-mechanism-not-distinguished caveat
   `specs/016`'s own record already carries, not a new gap.

## Known open items

- The raw-mode real-TTY masked-input path for this specific prompt
  wasn't separately re-exercised here (it shares `promptLine()` with
  every other wizard prompt, whose raw-mode behavior has its own
  still-open gap tracked under `specs/031`).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/034-init-wizard-services-ux/spec.md` (implemented, `verified`;
amends 031) changed the wizard's "Services to run" prompt
after live user feedback via `npx orchestrai`: it now lists only the
real agents, numbered (originally `1) planning-agent` … `5)
security-agent`; as of `specs/051-planning-retirement-and-required-key/
spec.md`, `1) devops-agent` … `4) security-agent` — planning-agent is
deleted, see "Planning Agent (retired)" above), and
accepts comma-separated numbers (e.g. `2,4`) alongside the pre-existing
exact-name input; `mcp:http` and `orchestrator` are no longer choosable
items at all — both are implied. `mcp:http`'s existing runtime
auto-include (`needsMcp`/`mcpAlreadySelected` in `apps/supervisor/
index.ts`) is untouched; `orchestrator` is now always appended to the
`ORCHESTRAI_ONLY` value the wizard *persists* to `config.env` whenever a
non-empty subset was chosen (`formatConfigEnv()` in `apps/supervisor/
init-wizard.ts`), so a wizard-written config can never produce a
coordinator-less startup — this is new, not a restatement of `mcp:http`'s
existing behavior, since `mcp:http`'s inclusion is decided live at
dispatch time and never written to disk, while `orchestrator`'s is
written. Re-running `init` against a config saved by the pre-034 wizard
(no `orchestrator` in its `ORCHESTRAI_ONLY`) pre-fills correctly with no
crash and never displays `orchestrator`/`mcp:http` as if they'd been a
prior choice — live-verified, along with the numbered-selection flow
itself and the persisted-file content. The one item originally deferred —
an actual zero-flag `orchestrai` startup against a wizard-written config
genuinely starting the orchestrator, skipped in the first pass because the
dev machine's own `orchestrai` stack was already running live on the same
ports — was exercised once ports were free (2026-09-01): a scratch config
matching exactly what the fixed wizard writes started all four expected
services, orchestrator included, confirmed via `GET /healthz` on each, not
log text alone. See
`specs/034-init-wizard-services-ux/verification.md` for the full record.
`--only`'s flag semantics and
`orchestrai service <name>` are unchanged (this checkpoint's only edit to
`apps/supervisor/index.ts` is the wizard's own call site).

See specs/072-init-form-empty-selection-means-no-agents/verification.md for the relocated narrative covering this checkpoint.
