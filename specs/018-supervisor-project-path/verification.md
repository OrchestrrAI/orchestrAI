## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  `specs/018-supervisor-project-path/spec.md` added a `--project <path>` flag,
  an `orchestrai.project.txt` config file next to the compiled binary, and
  a `process.cwd()` fallback as supervisor-level conveniences for what
  `ORCHESTRAI_PROJECT_PATH` to hand its own children — layered strictly on
  top of, never replacing, the unchanged shared-resolver policy described
  above; live-verified for all four sources including a case proving the
  config file genuinely outranks cwd.

See specs/030-authoritative-skill-dispatch-and-capability-catalog/verification.md for the relocated narrative covering this checkpoint.

See specs/016-orchestrai-supervisor/verification.md for the relocated narrative covering this checkpoint.
