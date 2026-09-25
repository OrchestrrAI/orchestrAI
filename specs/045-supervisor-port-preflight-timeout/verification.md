## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

  **Correction, 2026-09-02**: the port-preflight step this section calls
  "live-verified" had a real, live-caught gap — `isPortFree()`
  (`apps/supervisor/index.ts`) had no timeout at all. Yusuf hit it
  directly: `bun run orchestrai` printed the project-path line and then
  hung indefinitely, no further output, no error. A just-freed port can
  sit in a transitional state on Windows where a new bind neither errors
  nor succeeds promptly, and `isPortFree()`'s `Promise` then never
  resolved — unlike `waitForHealthy()` one step later in the same
  function, which already had a bounded timeout for exactly this class
  of risk. Fixed in `specs/045-supervisor-port-preflight-timeout/spec.md`
  (implemented, **verified**): a 3000ms bound (matching
  `waitForHealthy()`'s own `AbortSignal.timeout(3000)`), resolving
  `{free: false, reason: "timeout"}` — the same safe "refuse to start"
  outcome a genuine conflict produces — with the preflight message now
  naming which of the two occurred. Live-verified against a real
  conflict, not a lab setup: a second compiled-binary instance started
  against Yusuf's own already-running 7-service session correctly
  refused within seconds, no hang. Binary size delta: +512 bytes.

See specs/084-security-external-vulnerability-data/verification.md for the relocated narrative covering this checkpoint.

See specs/055-provider-call-budgets-and-transient-error-handling/verification.md for the relocated narrative covering this checkpoint.
