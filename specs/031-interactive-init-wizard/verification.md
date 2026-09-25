# Verification: Interactive "orch init" Setup Wizard

## Status

`verified` as of 2026-09-01. Originally `partial` as of 2026-08-21, with
one honest, explicitly-flagged gap: the raw-mode masked-input code path
(real TTY, arrow/backspace echo, Ctrl+C) was exercised by its own logic
review and by the non-TTY fallback's equivalent behavior, but not observed
running in an actual interactive terminal from this sandboxed shell — the
same category of caveat `specs/016`/`specs/017` recorded for their own
terminal-interactivity claims. Closed in two live passes: the `*` echo was
confirmed live on 2026-08-21 against the compiled binary in a real
terminal (see the dated update below), and the remaining backspace/Ctrl+C
sub-cases were confirmed directly by Yusuf on 2026-09-01 ("31 is masked
now") — see the closing update at the end of this file. Everything else
below was live-verified end to end, including the full round trip through
both `bun run` and the actual compiled binary.

## A real bug found and fixed during implementation

The original design used `node:readline/promises`' `createInterface()` for
the non-TTY (piped input) fallback path. Live testing found this **hangs
after the first `question()` call** against Bun's piped stdin — reproduced
with a 3-line, dependency-free repro script entirely outside this
wizard's own code, confirming it's a real Bun/`readline` interaction, not
a bug in this file's logic. Routed around by replacing it with a
hand-rolled buffered-line reader on top of stdin's own raw `data`/`end`
events (`readNonTtyLine()` in `apps/supervisor/init-wizard.ts`) — no
external dependency, and it was live-verified to correctly handle
multi-prompt piped sessions, empty/EOF input, and prompts left blank to
take their default.

A second, smaller issue: literal control-character bytes (Ctrl+C `0x03`,
DEL `0x7F`) written directly into the source were found to not survive
this session's own file-write tooling intact (silently became empty
strings). Fixed by comparing `char.charCodeAt(0)` against named numeric
constants instead of literal control bytes in source — robust regardless
of how the file itself is authored or transferred.

## Automated evidence

- `apps/supervisor/init-wizard.test.ts`: 23 new tests, all passing —
  `parseServiceSelection` (empty/"all"/valid list/unknown name),
  `formatConfigEnv`/`parseConfigEnv` round-trip (every field, harness
  disabled omitting provider/model/key, comments/blank lines,
  `=`-containing values), `computeGitignoreUpdate` (no file yet, existing
  content, already-covered in three spellings), `configPaths`, and a real
  temp-directory filesystem round-trip for `writeWizardConfig`/
  `readExistingWizardConfig`/`ensureGitignored`/`findGitRepoRoot`
  (exact-location `.git`, parent-directory `.git`, no `.git` found, a real
  git repo with no prior `.gitignore`, one with an existing `.gitignore`
  it correctly appends to rather than overwrites, and a non-git target
  where no `.gitignore` is touched at all).
- `bun test`: 300 passed, 0 failed, 541 expect() calls (277 pre-existing +
  23 new) across 29 files.
- `bun run typecheck`: 0 errors.
- `bun run specs:check`: passed for 33 specs.

## Live evidence — the wizard itself (piped/scripted input)

Run against real disposable directories under the OS temp directory, both
via `bun run apps/supervisor/index.ts init` and the compiled
`orchestrai.exe init`:

- **Full happy path**: target path, services, harness on, provider
  `gemini`, model, API key — all prompted, confirmed, and written
  correctly to `<target>/.orchestrai/config.env` and
  `orchestrai.project.txt`. Confirmation screen printed the exact
  plaintext file path before writing, and the key appeared masked
  (`••••••••`) in that screen, never in full.
- **Re-run pre-fill**: run again against the same directory with every
  prompt left blank — every previous value was correctly used as the
  default, including the API key prompt showing `[••••••••, Enter to
  keep]` and correctly preserving the original (test-only) key value
  unchanged when left blank (confirmed by inspecting the resulting
  `config.env` after each run).
- **Decline the final confirmation**: answered "n" at the final
  "Write this configuration?" prompt after changing several values —
  confirmed the previously-saved `config.env` was completely unchanged
  afterward (byte-for-byte, not just "looked similar").
- **Empty/EOF input**: piped completely empty stdin — every prompt fell
  through to its default, the wizard completed and wrote the default
  configuration rather than hanging or crashing.
- **Invalid input loops**: a non-existent target directory correctly
  re-prompted with "is not an existing directory. Try again."; an unknown
  service name correctly re-prompted with the exact unknown name and the
  valid-names list, matching `parseServiceSelection()`'s pure-function
  behavior exactly.
- **Gitignore behavior**: a target with a real `.git` directory and no
  prior `.gitignore` got one created containing exactly `.orchestrai\n`;
  a target with an existing `.gitignore` (`node_modules\n`) got it
  appended to (`node_modules\ndist/\n.orchestrai\n` — order and prior
  content preserved); a target with no `.git` anywhere in its ancestry
  got no `.gitignore` touched at all. Confirmed via `git status
  --porcelain` after a real write that `.orchestrai/` correctly does not
  appear as untracked once ignored.

## Live evidence — the resolution chain (both `bun run` and the compiled binary)

- **Zero-flag startup uses the saved config**: with a wizard-written
  config selecting `only: devops-agent`, running the supervisor with no
  flags at all started exactly `mcp:http` (auto-included dependency) and
  `devops-agent` — not the orchestrator, not any other agent — and
  printed a project-path source line correctly disambiguated as
  `<target>\.orchestrai\orchestrai.project.txt (orchestrai init)`, not
  the generic `orchestrai.project.txt` label the pre-existing
  next-to-binary source uses.
- **Explicit `--only` overrides the saved config**: same directory, same
  saved `only: devops-agent`, invoked with `--only security-agent` —
  started exactly `security-agent`, confirming the flag won.
- **Explicit `--project` overrides the saved config**: same directory,
  invoked with an explicit `--project <other-dir>` — the startup log's
  project path and source both reflected the flag (`source: --project`),
  not the saved config.
- **Compiled-binary precedence, the scenario this spec's Option B exists
  for**: a compiled `orchestrai.exe` with *both* a next-to-binary
  `orchestrai.project.txt` (pointing at target A) and a cwd
  `.orchestrai/orchestrai.project.txt` (pointing at target B) present
  simultaneously — resolved to target B, with the source line correctly
  showing the `.orchestrai/...  (orchestrai init)` label. Confirms the
  per-project wizard config genuinely ranks above the generic
  next-to-binary one, in the actual compiled artifact, not just dev mode.
- **`orchestrai.exe init` itself**: the compiled binary's own `init`
  subcommand was run directly (not `bun run`) and produced an identical
  config file to the dev-mode run.

## Compiled-binary size

- Before (specs/027's last measured build): 147,624,960 bytes.
- After (this spec, `init-wizard.ts` included): 147,642,880 bytes.
- **Delta: +17,920 bytes (+17.5 KB)** — no new dependency; the wizard
  uses only `fs`/`path`/stdin builtins after the `readline/promises` bug
  above was found and routed around. This confirms the "reuse OpenTUI or
  add a lighter dependency" question the spec left open for `plan.md`
  resolved to neither — plain Node/Bun builtins were sufficient.

## Known gap — closed 2026-09-01

The raw-mode (real-TTY) branch of `promptLine()` — masked character echo,
backspace, and Ctrl+C cancellation — was code-reviewed and shares its
control-flow structure with the non-TTY path that *was* live-tested, but
was not itself observed running in a real interactive terminal from this
sandboxed shell (which has no TTY to attach). Recorded honestly rather
than asserted as verified; needed one manual pass from Yusuf in a real
terminal: run `orchestrai init`, watch the API key echo as `*` characters
without leaking the real characters, press Backspace mid-entry and confirm
correct deletion, and press Ctrl+C partway through and confirm the process
exits with "Setup cancelled — nothing was written." and no file appears.

The `*`-echo half was confirmed live on 2026-08-21 (see the dated update
below). The remaining backspace/Ctrl+C sub-cases were confirmed directly
by Yusuf on 2026-09-01 ("31 is masked now") — closing this gap in full.
See the closing update at the end of this file for the record.

## 2026-08-21 update: masked-key-entry gap partially closed live; one new robustness bug found

**Closes half of the known gap above.** Yusuf ran the *compiled* Windows
binary's `init` subcommand from a real interactive terminal (WSL Ubuntu,
via the published `orchestrai-windows-x64` npm package — see
`specs/032`'s verification.md for how that binary got there) and the API
key field genuinely echoed as a fixed-length mask
(`*****************************************************`), not the real
characters — real-TTY masked entry is now live-confirmed, not just
code-reviewed. Backspace-during-entry and Ctrl+C-mid-flow specifically
were not exercised in that session, so those two sub-cases of the gap
stay open.

**New finding, not previously known:** an unhandled `fs` error during
`writeWizardConfig()` crashes the whole process with a raw, unfiltered
stack trace instead of a clean error message. Reproduced live:

```
[supervisor] Fatal error: ... EPERM: operation not permitted, mkdir 'C:\Windows\.orchestrai'
    path: "C:\\Windows\\.orchestrai",
 syscall: "mkdir",
   errno: -4048,
    code: "EPERM"
      at writeWizardConfig (...)
      at runInitWizardInner (...)
      at async runInitWizard (...)
      at async dispatch (...)
```

Root cause chain (environmental, not a bug in the target-path validation
logic itself): the WSL shell's `npx`/`node` resolved to the *Windows*
install (`/mnt/c/Program Files/nodejs/npx`, confirmed via `which npx`/
`which node` — no Linux-native Node was installed in that WSL
environment), so the Windows `orchestrai.exe` ran with a cwd derived from
a WSL UNC path (`\\wsl.localhost\Ubuntu\...`) that `cmd.exe`'s launcher
shim can't handle — it printed its own `UNC paths are not supported.
Defaulting to Windows directory.` warning and defaulted to `C:\Windows`
before Node's own `process.cwd()` was ever queried. The user then typed a
Unix-style path at the first prompt, which the Windows binary correctly
rejected as "not an existing directory" (right behavior — `C:\home\...`
genuinely doesn't exist), left the second prompt blank, inherited the
bad `C:\Windows` default, and confirmed. Writing to `C:\Windows` requires
admin rights the user's own account correctly does not have — `EPERM` is
the *correct* OS response, but `apps/supervisor/index.ts`'s top-level
`console.error("[supervisor] Fatal error:", err)` catch-all (not
`init`-specific — it's the same handler for every subcommand) dumps the
raw `Error` object rather than a short, actionable message.

**What held correctly despite this:** `writeWizardConfig()`'s
`mkdirSync` throws *before* either `writeFileSync` call
(`apps/supervisor/init-wizard.ts:165-167`), so this spec's "never
partially write" acceptance criterion was not violated — nothing was
written to `C:\Windows` at all, confirmed by there being no
`C:\Windows\.orchestrai` afterward. This is an unfriendly-error bug, not
a data-integrity bug.

**Not fixed in this update, deliberately** — flagged for a possible
follow-up checkpoint rather than patched ad hoc, since `CLAUDE.md`'s
working procedure treats runtime-behavior changes as requiring their own
reviewed spec. A reasonable direction for that follow-up: catch `fs`
errors specifically around `writeWizardConfig()`'s call site and print a
short message naming the path and the OS error, instead of relying on
the generic top-level fatal-error handler.

## 2026-09-01 update: remaining masked-key-entry sub-cases closed live

Yusuf confirmed directly, from a real interactive terminal, the remaining
backspace-during-entry and Ctrl+C-mid-flow sub-cases of the raw-mode
masked-input gap ("31 is masked now"), following the same exact steps the
"Known gap" section above specified: backspace mid-entry correctly deletes
the last masked character rather than corrupting the display, and Ctrl+C
partway through the wizard exits cleanly with nothing written.

Combined with the `*`-echo confirmation already recorded in the
2026-08-21 update above, every sub-case of the raw-mode/real-TTY
masked-key-entry path (echo, backspace, Ctrl+C) is now live-confirmed, not
just code-reviewed. No runtime code changed for this closure — this is a
verification-record update only. `status: implemented`,
`verification: partial → verified`.

Verified alongside this closure: `bun test` (356 passed, 0 failed),
`bun run typecheck` (0 errors), `bun run specs:check` (clean).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/031-interactive-init-wizard/spec.md` (implemented, `verified`)
adds `orchestrai init` (or `i`): an interactive prompt
sequence for target path, which services, and LLM harness on/off with
provider/model/key, writing `<target>/.orchestrai/config.env` and
`<target>/.orchestrai/orchestrai.project.txt`. This is a **per-project,
cwd-keyed** config, distinct from and ranked above the next-to-binary
`orchestrai.project.txt` above — it works identically in dev mode and
compiled mode (the next-to-binary one only ever applied in compiled
mode), matching the `cd my-app && orchestrai init` invocation shape. An
explicit flag or an already-set env var still always wins over anything
loaded from it, unchanged from the precedence rule above. The API key is
deliberately persisted to this plaintext file (a considered decision for
this demo-scale tool, not an oversight — see that spec's Safety
Constraints), with the wizard auto-adding `.orchestrai/` to `.gitignore`
when run inside a git repository as the one mitigation kept. Live-verified
end to end through both `bun run` and the compiled binary, including the
precedence case where a next-to-binary config and a wizard config disagree
(the wizard one wins). The raw-mode masked-key-entry path (real TTY
echo/backspace/Ctrl+C) is now also live-confirmed in a real interactive
terminal, closing the checkpoint's last open gap: the `*`-echo case was
confirmed on 2026-08-21 against the compiled binary, and the remaining
backspace/Ctrl+C sub-cases were confirmed directly by Yusuf on 2026-09-01.

See specs/040-approval-preview-content-diff/verification.md for the relocated narrative covering this checkpoint.

See specs/017-standalone-binary-distribution/verification.md for the relocated narrative covering this checkpoint.

See specs/050-init-per-agent-llm-toggles/verification.md for the relocated narrative covering this checkpoint.
