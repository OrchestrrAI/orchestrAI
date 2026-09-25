## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/078-capability-upgrade-roadmap/spec.md` (approved, governance —
no runtime change of its own) is a source-verified inventory of every
MCP tool against what each agent can actually reach, plus a five-phase
ordering for closing the gaps, agreed with Yusuf 2026-09-12. Its
headline finding: **4 of this codebase's 13 MCP tools
(`docker_build`, `docker_status`, `git_diff`, `git_commit`) were fully
implemented but reachable by no agent at all** — only the external
stdio surface could call them. The roadmap's phases (Track 0 chat/
timeout/LLM-default fixes; **A** connect what exists; **B** the
approved-execution primitive `run_command`, gated on A; **B′**
deterministic ecosystem expansion; **C** Testing writes tests; **D**
Code Review Agent, read-only; **E** Coder Agent, gated on C+D; **F**
Security external data) are ordered by an explicit rule: a phase adding
a new risk class doesn't start until the phase proving the mechanism it
depends on is `verification: verified`. See that spec's own `plan.md`
for full per-phase scope, exit gates, and the deferred-open-decisions
list (hosted/remote MCP servers, external A2A agents).

See specs/080-run-command-approved-execution/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.

See specs/114-coder-multi-file-edit-and-create/verification.md for the relocated narrative covering this checkpoint.

See specs/084-security-external-vulnerability-data/verification.md for the relocated narrative covering this checkpoint.

See specs/101-per-agent-tool-access-expansion/verification.md for the relocated narrative covering this checkpoint.
