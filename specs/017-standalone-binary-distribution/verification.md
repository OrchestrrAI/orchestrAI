## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`bun run build` (`scripts/build-binary.ts`,
`specs/017-standalone-binary-distribution/spec.md`) compiles the entire
runtime — all 4 agents, the MCP HTTP server, the Orchestrator, the
supervisor, and the TUI — into **one** standalone executable
(`dist/bin/orchestrai[.exe]`) via `bun build --compile`; the resulting
binary needs neither Bun nor this source tree to run. ~106 MB was this
command's own original size before `specs/020-semantic-intent-fallback/spec.md`
existed; as of that spec, `bun run fetch-model` must be run first —
`bun build --compile` fails outright without it, does not degrade
gracefully — bringing the real current size to ~137 MB (see that spec's
Commands section above for the exact failure this omission caused in CI). `apps/supervisor/
index.ts` is the single compiled entry point: with no arguments it runs
supervisor logic and self-spawns each child as `orchestrai service <name>`
(dynamic-`import()`-dispatched from `SERVICE_STARTERS`, all bundled into
the one binary); `orchestrai service <name>` runs exactly one service;
`orchestrai tui` runs the terminal viewer; `orchestrai init` (or `i`) runs
the interactive setup wizard (`specs/031-interactive-init-wizard/spec.md`).
Every service file that used to
call `serve()`/`Bun.serve()` unconditionally at module top level now
exports a `start()` function guarded by `if (import.meta.main)` — `bun run
<service-script>` is completely unaffected, this only adds the ability to
import-and-call-on-demand. **One real, non-obvious bug found and fixed
during this work**: `import.meta.dir` resolves to Bun's internal virtual
path for the embedded bundle inside a compiled binary (e.g. `B:\~BUN\root`
on Windows), not a real directory — the supervisor's `REPO_ROOT` (computed
from it) is therefore only valid in dev mode; passing it as `Bun.spawn()`'s
`cwd` in compiled mode broke self-spawning with a misleading ENOENT on the
target executable, not an obviously-wrong-cwd error. Fixed by making `cwd`
conditional (`undefined` in compiled mode, inheriting the parent's real
cwd). Host-platform-only in this pass — no cross-compilation matrix.

  `specs/017-standalone-binary-distribution/spec.md` added `bun run build`,
  compiling the entire runtime into one ~106 MB `dist/bin/orchestrai[.exe]`
  (not 8 separate ~98 MB-each binaries, an earlier design explicitly
  revised after Yusuf flagged the ~780 MB total that would have produced).
  Live-verified end to end: full standalone startup, `service <name>`,
  `tui`, a real task completing, and clean shutdown (same
  outcome-confirmed/mechanism-unconfirmed caveat as the supervisor above).
  Found and fixed one genuinely non-obvious bug along the way:
  `import.meta.dir` resolves to Bun's internal virtual bundle path inside a
  compiled binary, not a real directory, which broke `Bun.spawn()`'s `cwd`
  during self-spawning — every test and typecheck passed throughout; only
  running the actual compiled artifact caught it. See that spec's
  Verification Results for the full root-cause trail. A follow-up round on
  the same day auto-opens the terminal viewer in a real interactive
  terminal (gated on `process.stdout.isTTY`, `--headless` to opt out) —
  its first real-terminal test found and fixed a second real bug (the
  auto-launch code force-exited the whole app within a fraction of a
  second of the TUI appearing, since `tui`'s `start()` only initializes
  the renderer and returns almost immediately rather than blocking until
  quit); both specs' own Verification Results have the full detail.

See specs/016-orchestrai-supervisor/verification.md for the relocated narrative covering this checkpoint.

See specs/054-capability-driven-llm-routing/verification.md for the relocated narrative covering this checkpoint.
