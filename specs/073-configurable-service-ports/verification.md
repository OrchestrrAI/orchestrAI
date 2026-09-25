# Verification — 073 Configurable Service Ports

Status: **partial** — every layer is live-verified end to end against
real running processes (not just unit tests): a custom port genuinely
changes what a service binds, what the Orchestrator discovers, and what
the supervisor preflights/health-checks/prints. The one item left is the
standard every guided-init checkpoint in this codebase carries: a real
interactive keystroke-driven pass over the new Ports section, in Yusuf's
own terminal.

## What changed

### 1. `packages/shared/service-ports.ts` (new)

Single source of truth: `SERVICE_PORT_ENV_VARS`, `DEFAULT_SERVICE_PORTS`,
and `resolveServicePort(service, env?)` — reads
`ORCHESTRAI_<SERVICE>_PORT`, falls back to the default for anything
unset, empty, non-numeric, or out of the 1–65535 range. Never throws.

### 2. The six `PORT` constants

`apps/orchestrator/index.ts`, `packages/agents/{devops,testing,
documentation,security}/index.ts`, `packages/mcp/http.ts` — each
`const PORT = <literal>` replaced with `resolveServicePort("<key>")`.

### 3. Discovery follows the port

`packages/shared/agent-registry.ts`: each agent's default URL is now
built from `resolveServicePort()` instead of a hardcoded literal; the
existing `ORCHESTRAI_<AGENT>_URL` full-URL override still wins first,
unchanged.

`packages/shared/mcp-client.ts`: the same pattern for
`ORCHESTRAI_MCP_URL`'s own default, built from `resolveServicePort
("mcpHttp")`.

### 4. The supervisor's own port table, resolved after env merge

`apps/supervisor/index.ts`: `ServiceDef` gained a `portKey` field;
`MCP_HTTP`/`AGENTS`/`ORCHESTRATOR` now seed `port` from
`DEFAULT_SERVICE_PORTS` at module load (safe pre-merge fallback for
`--help`/`--only` validation), and a new exported `resolveServicePorts()`
mutates every def's `port` field in place from real `process.env` —
called from `main()` immediately after the `.orchestrai/config.env`
merge, closing the exact ordering hazard the spec's Verified Current
State section identified. `isPortFree()`, `waitForHealthy()`, and the
startup summary all read `.port` afterward, unchanged otherwise.

### 5. Guided-init: the Ports section

`apps/supervisor/init-wizard.ts`: `WizardConfig.ports:
Partial<Record<ServicePortName, number>>`; `formatConfigEnv()` writes
`ORCHESTRAI_<SERVICE>_PORT=<n>` only for a service whose value differs
from its own default; `WIZARD_OWNED_KEYS` gained the six port vars; the
classic wizard always passes `ports: {}` (it doesn't ask, same as
`modelOverrides`).

`apps/supervisor/init-form-state.ts`: a new Ports section, structurally
identical in shape to specs/071's Models section but simpler (no
provider/picker) — `SERVICE_PORT_ROWS` (all 6, always, regardless of
agent selection), `movePortsCursor`/`serviceAtPortsCursor`/
`portOverrideAtCursor`/`setPortOverrideAtCursor` (raw string, mirrors
`modelOverrides`' empty-means-default convention), `resolvedPort()`
(parses one row, `null` for invalid), `portsValidationErrors()` (range +
cross-row duplicate detection), wired into `validate()` (`errors.ports`,
blocks `canSave`), `formStateToWizardConfig()` (only a valid,
non-default override is carried across), `initialFormState()`
(`seedPortOverrides()` — round-trips a hand-edited or previously-saved
value verbatim), and `fieldScrollOffset()` (extended with a
`modelsRowCount` parameter so the new "ports" field scrolls to the right
place regardless of how many LLM agents are selected — the Models
section's own hint/picker lines never render while unfocused, confirmed
by tracing the keyboard handler's own precedence, so its unfocused row
count is exactly `1 + modelsRows(state).length`, no dynamic-height
tracking needed).

`apps/supervisor/init-form.tsx`: `PortsSection` component (header +
6 rows, cursor highlight, `(default: N)` placeholder vs. a typed
override, inline error line); keyboard handling for `focus === "ports"`
(↑/↓ move, digits-only typed input, backspace, Enter moves to the next
row); paste handling (strips non-digits from the pasted text); the `p`
Providers-detour guard extended to also exclude `focus === "ports"`.

`apps/supervisor/init-web.ts`: needed no code change — `parseSubmission`
spreads `...base` from `initialFormState()`, which already carries
`portOverrides`/`portsCursor` through untouched (browser form's own
Ports UI is explicitly deferred, per the spec's Scope).

## Tests

- `packages/shared/service-ports.ts` — exercised indirectly via every
  call site's own tests; `resolveServicePort()`'s own range/parse logic
  is additionally covered by `init-form-state.test.ts`'s `resolvedPort`/
  `portsValidationErrors` tests (same parsing rule, same boundary
  values).
- `apps/supervisor/init-form-state.test.ts` — new `describe("specs/073 —
  the Ports section")` block: row order, cursor wrap, override set/clear,
  `resolvedPort` (default/valid/invalid), `portsValidationErrors` (clean/
  out-of-range/duplicate), `validate()` surfacing `errors.ports` and
  blocking `canSave`, `formStateToWizardConfig` (unedited → `{}`; a
  genuine override → carried; an override equal to the default → not
  written; an invalid override → not written), `formatConfigEnv` writing
  exactly one `ORCHESTRAI_<SERVICE>_PORT` line for one overridden
  service, seeding round-trip, and `fieldScrollOffset`'s new
  `modelsRowCount` parameter. Also updated: `visibleFields`/`moveFocus`
  tests for the new 4-field list (was 3).
- `apps/supervisor/init-wizard.test.ts` / `init-web.test.ts` — every
  hand-built `WizardConfig`/`Omit<WizardConfig,...>` literal gained
  `ports: {}` (or, for the `WIZARD_OWNED_KEYS` drift-guard test, a fully
  populated `ports` object exercising all 6 keys — proving that test
  still catches a future port var missing from `WIZARD_OWNED_KEYS`, not
  just the pre-existing fields).

## Suite

- `bun test` — 897 pass, 0 fail (up from the pre-073 baseline of 883).
- `bun run typecheck` — 0 errors.
- `bun run specs:catalog` + `bun run specs:check` — pass, 73 specs.

## Live verification (real processes, not mocks)

**1. A custom port genuinely changes what a service binds**, confirmed
against the real DevOps agent process:
```
ORCHESTRAI_DEVOPS_PORT=19002 bun run packages/agents/devops/index.ts
curl http://localhost:19002/healthz   → {"status":"ok",...}
curl http://localhost:3002/healthz    → connection refused
```

**2. Discovery genuinely follows the port — the spec's own decisive
acceptance criterion**, confirmed with two real, separately-started
processes sharing only `ORCHESTRAI_DEVOPS_PORT=19002` (no
`ORCHESTRAI_DEVOPS_URL` set at all):
```
GET http://localhost:3000/agents
→ {"count":1,"agents":[{"name":"devops-agent",
    "url":"http://localhost:19002","status":"online",...}]}
```
The Orchestrator's own `agentRegistry`-driven `KNOWN_AGENTS` discovery
correctly polled port 19002 and found DevOps online there — proof the
port-var-to-URL construction in `agent-registry.ts` works, not just that
each side independently resolves the same env var.

**3. The supervisor's own preflight/health-check/startup-summary track
the resolved port**, confirmed against the real supervisor process:
```
ORCHESTRAI_SECURITY_PORT=19005 bun run apps/supervisor/index.ts \
  --only security-agent --project <scratch-dir>
→ [security-agent] Dashboard → http://localhost:19005/dashboard
→ [supervisor] === Startup summary ===
    ✓  security-agent       http://localhost:19005/dashboard
```
Preflight passed (no false "port in use" against the old 3005) and
health-check succeeded against 19005 — proof `resolveServicePorts()`
firing after the config-env merge, not at module load, actually closes
the ordering hazard.

**4. mcp:http's own port**, confirmed the same way:
```
ORCHESTRAI_MCP_PORT=19006 bun run packages/mcp/http.ts
curl http://localhost:19006/healthz   → {"status":"ok",...}
curl http://localhost:3006/healthz    → connection refused
```

**One unrelated pre-existing bug found and confirmed NOT caused by this
spec**: killing the supervisor process via a forced `timeout`-triggered
SIGTERM during the `security-agent`-only run above threw
`TypeError: number is not iterable` inside `killAllChildrenSync()`
(`apps/supervisor/index.ts:462`) on `process.on("exit")`. Reproduced
identically with **no** port override set at all (the default-port run
hit the exact same crash, same line, same message) — confirming this is
a latent, pre-existing bug in the forced-kill shutdown path, unrelated
to specs/073's changes, and out of this spec's scope to fix.

## Live PTY smoke of the Ports section's rendering (real 80×24 PTY)

Same temporary state-injection technique specs/069–072 already
established: `init-form-state.ts` was patched (via `sed`, backed up
first) to force `view: "setup"`, `focus: "ports"`, and
`portOverrides: { devops: "9002" }`, run under `timeout 5 bun run
<scratch>.tsx` in this environment's real fixed-80×24 PTY, then the
scratch file was deleted and the source file restored from its backup —
confirmed via `git diff --stat` showing only the real spec-073 diff
(147 insertions / 8 deletions in `init-form-state.ts`, matching the
actual implementation, not the smoke patch) and a fresh
`bun run typecheck`/`apps/supervisor` test pass (239/239) afterward.

Decoded output confirmed:
- The section header: `Ports  ↑↓ move · type to override, backspace to
  clear`.
- All 6 rows present, correctly labeled: `orchestrator`, `devops-agent`,
  `testing-agent`, `documentation-agent`, `security-agent`, `mcp:http`.
- An unedited row shows `(default: N)` in dim gray; the injected
  `devops-agent → 9002` override renders in the normal (non-dim) value
  color, distinct from the placeholder.
- The cursor (`▸`, highlighted background) correctly sat on the focused
  `orchestrator` row.
- The scrollbox correctly auto-scrolled the Ports section into view
  (via the `fieldScrollOffset()` fix) even though it's the last,
  furthest-down section on the setup screen.
- No wrapped, truncated, or corrupted line at the 80×24 minimum.

**Not verified**: the picker's own genuine keystroke-driven interaction
(Tab into Ports, type digits, backspace, hit a duplicate/out-of-range
value and see the live error, save and confirm the written
`config.env`) — this environment has no raw-mode stdin to drive it; the
same standard every guided-init checkpoint in this codebase carries.

## Live pass still owed (Yusuf's terminal)

1. Tab to the Ports section in a real interactive run; type a custom
   port on one row, confirm it renders live and the "(default: N)"
   placeholder disappears.
2. Type a duplicate or out-of-range value and confirm the error line
   renders and `^S`/`^X` are refused until it's fixed.
3. Save, and confirm the written `.orchestrai/config.env` contains
   exactly one `ORCHESTRAI_<SERVICE>_PORT=<n>` line for the edited row
   and nothing for any unedited one.
4. Start `orchestrai` from that config and confirm the affected service
   genuinely comes up on the custom port (this item is otherwise already
   closed at the process level by the live verification above — this is
   specifically about the guided-init form's own save-then-start path).

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**`specs/073-configurable-service-ports/spec.md` (implemented,
`verification: partial`; amends `016`/`048`/`071`), 2026-09-11.** Closed
a real, long-documented gap in this file's own "Known limitations"
section: every one of the 6 services (`orchestrator`, the 4 agents,
`mcp:http`) had its own independently hardcoded `const PORT = <n>`, and
`apps/supervisor/index.ts` kept a second, separately hardcoded copy of
the same 6 numbers for its own preflight/health-check/startup-summary —
the two agreed only because both sides happened to hardcode the same
literals. Yusuf's request: *"will need also to choose the ports of the
agents, the default as is, but also need to have the ability to set the
ports."* — approved with *"can chose all of them"*, confirming scope
covers all 6 services (including `mcp:http`), not just the 4 visible
agents.

Each service now reads its own bind port from
`ORCHESTRAI_<SERVICE>_PORT` (new `packages/shared/service-ports.ts`,
`resolveServicePort()` — unset/malformed always falls back to that
service's original literal, never throws). Making a custom port
*discoverable*, not just bindable, needed two more changes:
`packages/shared/agent-registry.ts` and `packages/shared/mcp-client.ts`
now build their default discovery URLs from the same port vars (the
existing `ORCHESTRAI_<AGENT>_URL`/`ORCHESTRAI_MCP_URL` full-URL
overrides still win first, unchanged) — **live-proven with two
independently started real processes sharing only
`ORCHESTRAI_DEVOPS_PORT=19002`** (no `_URL` set at all): the real
Orchestrator's `GET /agents` correctly showed DevOps online at
`http://localhost:19002`, not the old 3002. And `apps/supervisor/
index.ts`'s own `ServiceDef[]` port table — previously evaluated at
module-load time, before `.orchestrai/config.env` is ever merged into
`process.env` inside `main()` — is now refreshed by a new
`resolveServicePorts()` call placed immediately *after* that merge,
closing the exact ordering hazard this spec's own investigation found;
**live-proven** with a real `orchestrai --only security-agent` run
(`ORCHESTRAI_SECURITY_PORT=19005`): preflight, health-check, and the
printed startup summary all correctly targeted 19005, not 3005.

The guided-init TUI form gains a **Ports section**, structurally
mirroring `specs/071`'s Models section on the same setup screen (one
more `Tab`-reachable field, `↑/↓` moves a row cursor) but simpler — no
provider/picker, just 6 rows (always all 6, regardless of agent
selection — a port matters even for a service not currently chosen to
start), digits-only typed input, an empty row meaning "use the
default", and validation for both out-of-range values and two services
resolving to the same port (a real, visible error, never a silent
last-write-wins). `WizardConfig` gained a `ports` field;
`formatConfigEnv()` writes `ORCHESTRAI_<SERVICE>_PORT=<n>` only for a
service whose value genuinely differs from its own default, so an
unedited Ports section writes nothing at all — the classic wizard and
the browser form (`init-web.ts`, which needed no code change of its
own — it already spreads `...base` from `initialFormState()`) both
inherit this unchanged. 14 new pure-state tests
(`init-form-state.test.ts`), `bun test` 897 pass (up from 883),
typecheck clean. Live-smoked in a real PTY at 80×24 (same
state-injection technique the 069–072 smokes used): all 6 rows render
correctly labeled with their defaults, an injected override renders
distinctly from the placeholder, and the scrollbox correctly
auto-scrolled the new section into view. **One unrelated pre-existing
bug found and confirmed NOT caused by this spec, while live-testing the
supervisor**: a forced `timeout`-triggered SIGTERM during a real
supervisor run threw `TypeError: number is not iterable` inside
`killAllChildrenSync()` on `process.on("exit")` — reproduced identically
with no port override at all, confirming it predates this spec; flagged,
not fixed, out of scope here. **Not verified**: a genuine
keystroke-driven pass over the Ports section (type a port, hit a
duplicate/out-of-range error, save, confirm the written config and a
real service start on the custom port) — the standard open item every
guided-init checkpoint in this codebase carries. See that spec's
`verification.md` for the full record, including the exact live-process
transcripts.

- ~~Ports and agent URLs are hardcoded.~~ Ports are now configurable —
  see `specs/073-configurable-service-ports/spec.md` below. Agent
  *discovery* URLs remain overridable only via the existing
  `ORCHESTRAI_<AGENT>_URL`/`ORCHESTRAI_MCP_URL` full-URL variables (for
  pointing at a different host entirely); the port piece of that gap is
  closed.

See specs/082-code-review-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/099-tui-port-url-and-analyze-project-stack-awareness/verification.md for the relocated narrative covering this checkpoint.

See specs/074-fix-exit-backstop-argument-bug/verification.md for the relocated narrative covering this checkpoint.
