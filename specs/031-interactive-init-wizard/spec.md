---
id: 031-interactive-init-wizard
title: Interactive "orch init" Setup Wizard
area: supervisor
change_type: feature
status: implemented
verification: verified
created: 2026-08-21
updated: 2026-09-01
approved_by: Yusuf
approved_on: 2026-08-21
implemented_on: 2026-08-21
amends: []
supersedes: []
superseded_by: []
related:
  - 016-orchestrai-supervisor
  - 018-supervisor-project-path
  - 026-llm-harness-langgraph-planning
  - 029-shared-llm-provider-gemini
---

# Spec: Interactive "orch init" Setup Wizard

> Status history: **APPROVED (2026-08-21 by Yusuf), IMPLEMENTED the same
> day. VERIFIED 2026-09-01** — the one remaining gap (the raw-mode
> real-TTY masked-key-entry path: `*` echo, backspace, Ctrl+C) was closed
> in two live passes: the `*` echo was confirmed live on 2026-08-21
> against the compiled binary in a real terminal, and the remaining
> backspace/Ctrl+C sub-cases were confirmed directly by Yusuf on
> 2026-09-01 ("31 is masked now"). See `verification.md`.

## Purpose

Add `orchestrai init` (and the shorter `orchestrai i`): an interactive
terminal prompt flow that asks a first-time user for the handful of
choices `bun run orchestrai`/the compiled binary already accepts as
flags/env vars, then writes them to a config file so every future launch
in that directory needs no flags at all.

This is explicitly a **convenience layer on top of the existing resolution
chain**, not a new configuration mechanism. Every value the wizard collects
already has a real, working source today (a CLI flag, an env var, or
nothing/disabled) — this checkpoint's only job is asking for them
interactively once and persisting the answers.

## Verified Current State

- `apps/supervisor/index.ts`'s `parseArgs()` accepts `--only`, `--project`,
  `--headless`, `--help` today. No `init` subcommand exists — `argv[0]` is
  matched against `service`/`tui`/`headless`/flag forms only
  (`apps/supervisor/index.ts` around line 458's subcommand dispatch).
- Target-path resolution is `resolveProjectPath()`
  (`apps/supervisor/index.ts`): `--project` flag → already-set
  `ORCHESTRAI_PROJECT_PATH` → `orchestrai.project.txt` next to the binary
  (compiled mode only) → `process.cwd()`. This is the **only** file-based
  config source that exists in the runtime today, and it holds exactly one
  line: an absolute path. (`specs/018-supervisor-project-path/spec.md`.)
- `--only <name[,name...]>` selects a subset of the 7 services
  (`mcp:http`, `planning-agent`, `devops-agent`, `testing-agent`,
  `documentation-agent`, `security-agent`, `orchestrator`) to start; no
  `--only` starts all 7.
- The LLM harness (`specs/026`, `specs/029`) is controlled entirely by
  environment variables read directly by the Planning agent process at
  startup: `ORCHESTRAI_LLM_HARNESS`, `ORCHESTRAI_LLM_PROVIDER`,
  `ORCHESTRAI_LLM_API_KEY`, `ORCHESTRAI_LLM_MODEL`. The supervisor does not
  read, validate, or pass these through specially today — they are
  whatever the parent shell's environment already has when the supervisor
  spawns its children.
- There is no interactive-prompt dependency in `package.json` today
  (`bun run orchestrai --headless`'s own doc comment explicitly frames
  interactivity as "attach an interactive renderer," referring to the TUI,
  not a setup prompt).
- `apps/tui` already depends on `@opentui/react`, proving an interactive
  terminal rendering stack is already a project dependency — relevant
  because it means this checkpoint does not have to introduce a *new*
  terminal-UI toolkit, only decide whether to reuse OpenTUI or add a
  lighter dedicated prompts library for a linear Q&A flow (see Open
  Decision).

## Proposed Behavior

1. `orchestrai init` runs a linear, cancellable (Ctrl+C at any point exits
   cleanly, writes nothing) sequence of prompts:
   - **Target project path** — free-text input, defaulting to
     `process.cwd()`. Validated as an existing absolute directory before
     accepting (same absolute-path requirement the shared resolver already
     enforces elsewhere — this wizard does not relax it).
   - **Which services to run** — a multi-select over the same 7 names
     `--only` already accepts, defaulting to "all". Selecting a subset here
     is equivalent to writing `--only` every time.
   - **LLM harness** — a yes/no. If yes:
     - **Provider** — single-select `anthropic` / `openai` / `gemini`,
       matching `readLlmModelConfig()`'s existing exact set
       (`packages/shared/llm-model-factory.ts`) — this wizard does not
       invent a fourth option.
     - **API key** — free-text input, **not echoed to the terminal**
       (masked, matching a standard password-prompt pattern).
     - **Model** — free-text input. Required if Gemini was chosen
       (`readLlmModelConfig()` already throws without one); optional
       otherwise, since Anthropic/OpenAI already have defaults.
   - **Confirmation summary** — echoes every choice **except the API key
     itself** (shown as a fixed-length mask, e.g. `••••••••`, never a
     partial reveal) and states plainly that it will be saved in plaintext
     to a local file, then asks a final yes/no before writing anything.
2. On confirmation, writes two files to `<target>/.orchestrai/` (see Scope
   for the location decision):
   - `orchestrai.project.txt` — path only, one line, format unchanged from
     `specs/018`.
   - `config.env` — `ORCHESTRAI_ONLY`, `ORCHESTRAI_LLM_HARNESS`,
     `ORCHESTRAI_LLM_PROVIDER`, `ORCHESTRAI_LLM_MODEL`, and
     `ORCHESTRAI_LLM_API_KEY`, as `KEY=value` lines.
3. `bun run orchestrai` / the compiled binary, run with **no flags**,
   loads this config before spawning children, populating `process.env`
   for the child processes exactly as if the equivalent flags/env vars had
   been set by hand. An explicit flag or an already-set env var still wins
   over the file, unchanged from every existing precedence rule in
   `specs/018`.
4. `orchestrai init` run again in a directory that already has a config
   pre-fills every prompt with the existing value — including the API key
   field, shown masked, not blank, so re-running the wizard to change one
   setting doesn't force retyping the key. Overwrites only on final
   confirmation.

## Safety Constraints

- **The API key is written to disk in plaintext.** Accepted deliberately
  for this checkpoint's actual use case (a demo/hackathon tool, run a
  handful of times on the operator's own machine — not a shared or
  production credential store), with the cheap mitigations that cost
  nothing to include:
  - The wizard states plainly, before writing, exactly where the key will
    be saved (e.g. "This will be saved in plaintext in
    `<target>/.orchestrai/config.env`") — never a silent write.
  - `<target>/.orchestrai/` is auto-added to `.gitignore` when a git
    repository is detected at or above the target path (append a line if
    not already covered, analogous to how DevOps's own `create-gitignore`
    skill already appends rather than overwrites) — the single most likely
    accident this prevents is the key ending up in a commit.
  - The key is masked on every input and confirmation screen, never
    echoed or logged in full.
  - No OS keychain / Credential Manager / Secret Service integration is
    attempted — flagged as a reasonable future hardening step if this tool
    ever moves beyond demo use, explicitly out of scope here.
- **No new prohibited action.** The wizard never submits a task, never
  approves anything, and never talks to the Orchestrator or any agent — it
  only writes local config files and then launches the existing
  supervisor.
- **Never silently overwrite an existing config.** Confirmation is
  mandatory even when every prompt was left at its pre-filled default.
- The wizard must never partially write — either both files are written
  after final confirmation, or neither is (an interruption mid-write must
  not leave a project path set with no matching env file or vice versa).

## Open Decision — resolved: Option B

**Where does the generated config live, and in what format?**

- **Option A — next to the binary**, matching `orchestrai.project.txt`'s
  existing precedent exactly (`specs/018`). Cost: only works cleanly for
  the compiled-binary distribution model; `bun run orchestrai` run from
  the repo root would write into the repo itself.
- **Option B — in the target project directory** (the path the wizard
  just asked for), e.g. `<target>/.orchestrai/config.env`. Matches "this
  is per-project configuration," works identically whether run from
  source or compiled.

**Chosen: Option B**, confirmed by Yusuf. It matches how a user would
actually invoke this (`cd my-app && orchestrai init`, mirroring the exact
`cd my-app && orchestrai` UX `context/history.md` already records as the
originally envisioned flow) and generalizes correctly to both the compiled
binary and `bun run orchestrai` run from source, which Option A does not.
Implementation will need one small resolution-order addition to
`resolveProjectPath()`'s sibling logic (which file wins if both a
next-to-binary `orchestrai.project.txt` and a per-project
`.orchestrai/config.env` exist) — recorded for `plan.md`, not decided
here.

## Scope

- `apps/supervisor/index.ts` — new `init` subcommand, prompt flow, config
  file read (in addition to existing sources) before spawning children.
- A new prompt-flow dependency, or reuse of the existing `@opentui/react`
  stack — resolved in implementation planning, not this spec (see Open
  Decision's cost note; a `plan.md` should record the concrete choice and
  why, since it affects binary size, which `specs/017`/`020`/`029` have all
  measured and recorded for prior dependency additions).
- `CLAUDE.md`, `README.md`, `context/worklog.md`.

## Out of Scope / Non-Goals

- OS keychain/secret-manager integration for the API key.
- Any change to `ORCHESTRAI_LLM_*`'s own semantics, `readLlmModelConfig()`,
  or the LLM harness itself — this checkpoint only automates setting the
  same environment variables that already exist.
- Any change to `bun run dev`, `bun run orchestrai`'s existing flag
  behavior, or `orchestrai.project.txt`'s existing format/precedence rules
  — this is additive only.
- A GUI/web-based setup flow — terminal-only, matching the rest of this
  project's CLI-first posture.
- Multi-project profiles (saving more than one named configuration) —
  one directory, one config, matching the existing one-`orchestrai.
  project.txt`-per-binary-location model.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `orchestrai init` completes a full prompt cycle and writes both
      files only after final confirmation; declining the final
      confirmation writes nothing and leaves an existing config untouched.
- [x] The confirmation screen states the exact plaintext file path before
      writing anything — verified as real prompt output, not assumed from
      the code.
- [x] `<target>/.orchestrai/` is auto-added to `.gitignore` when a git
      repository is detected at or above the target path — verified
      against both a repo with no `.gitignore` yet and one with an
      existing `.gitignore` that doesn't cover it (append, not overwrite),
      and confirmed absent when the target isn't a git repo at all.
- [x] Re-running `init` in a directory with an existing config pre-fills
      every value, including a masked (not blank) representation of the
      previously-saved API key, which is kept unchanged when the prompt is
      left blank.
- [x] The API key is masked on input and shown as a fixed-length mask
      (never partial) on the confirmation screen and in any log output.
- [x] `bun run orchestrai` / the compiled binary, invoked with **zero**
      flags, produces the correct startup behavior for the saved
      configuration — verified live against both `bun run` and the
      compiled binary, including the correct services subset and an
      accurate, disambiguated source label.
- [x] An explicit flag still overrides the generated config — verified
      live for both `--only` and `--project` against a saved config that
      specified something different.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` all pass.
- [x] `bun run build` binary size delta measured and recorded — no new
      dependency was added (the wizard uses only Node/Bun builtins after
      a live-found `node:readline/promises` bug was routed around; see
      `verification.md`), so the delta is small and purely code size.
- [x] `CLAUDE.md`, `README.md`, `context/worklog.md` updated after the
      above pass.

## Verification Plan

- Automated: full suite, typecheck, spec governance.
- Manual: run `orchestrai init` interactively in a real terminal (not a
  piped/non-interactive capture — matching the standard this repo already
  holds itself to for `specs/012`/`specs/017`'s terminal-interactivity
  claims) against a disposable target project; confirm the resulting
  config actually drives a real startup with no flags.
- `bun run build` before/after size comparison.

## Approval Requested

Approval authorizes adding an `init` subcommand to the supervisor, a new
prompt-flow dependency (exact choice recorded in `plan.md`), and a new
per-project (Option B) or next-to-binary (Option A) config file format, per
whichever option is chosen above. It does not authorize any change to the
LLM harness's own semantics or to any existing flag's behavior.
