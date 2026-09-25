---
id: 123-safe-env-template-filename-exemption
title: Exempt Safe .env Template Filenames From the Sensitive-Filename Denial
area: mcp-file-tools
change_type: fix
status: implemented
verification: verified
created: 2026-09-24
updated: 2026-09-24
approved_by: Yusuf
approved_on: 2026-09-24
implemented_on: 2026-09-24
amends:
  - 011-remaining-agents-mcp
supersedes: []
superseded_by: []
related:
  - 121-skill-description-grounded-routing
---

# Spec: Exempt Safe .env Template Filenames From the Sensitive-Filename Denial

> Status history: **APPROVED by Yusuf on 2026-09-24, IMPLEMENTED and
> VERIFIED the same day** — see this spec's own `verification.md` for full
> evidence, including a live check against an isolated MCP instance.

## Purpose

Live-reproduced via the TUI, immediately downstream of specs/121's routing
fix: once `edit-files` was correctly selected and the harness converged on
a concrete proposal (`create the .env.example please` against this repo),
the write itself was refused: `Cannot make this change: Creating
.env.example is denied by security policy because it matches sensitive
file patterns.` `.env.example` (and the equivalent `.env.sample`/
`.env.template`/`.env.dist` conventions) is a standard, git-committable
placeholder template — the entire point of the convention is that it is
safe to share, unlike `.env` itself. The current filename-only check has
no way to tell "real secrets file" from "documented placeholder template,"
so it blocks a completely legitimate, common request outright.

## Verified Current State

`packages/mcp/index.ts:22-34`:

```ts
const SENSITIVE_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /\.pfx$/i,
  /\.p12$/i,
]

function isSensitiveFilename(name: string): boolean {
  return SENSITIVE_FILENAME_PATTERNS.some((re) => re.test(name))
}
```

`isSensitiveFilename()` is called once, from `containPath()`
(`packages/mcp/index.ts:75-78`), the single shared path-resolution function
both the `read_project_file` and `write_project_file` MCP tools use
(confirmed by both tools' own descriptions at `index.ts:873` and `:912`:
"Same path-containment and sensitive-filename denial as read_project_file").
This is CLAUDE.md's own named highest-risk surface ("`read_project_file`/
`write_project_file` are the highest-risk surface in this codebase").

The `/^\.env(\..+)?$/i` pattern matches `.env` itself and **every**
`.env.<anything>` — deliberately broad to catch real secret-bearing
variants (`.env.local`, `.env.production`, `.env.development`,
`.env.test`), but with no exception for the well-known inverse convention:
a template file whose entire purpose is to be safe to commit. Live-observed
error text: `LLM harness run failed: Cannot make this change: Creating
.env.example is denied by security policy because it matches sensitive
file patterns` (from Coder's `isGrounded()`/refusal-surfacing path,
`specs/083`, which relays `write_project_file`'s thrown `PathContainmentError`
message verbatim).

`packages/mcp/project-file-tools.test.ts:92` and `:176` hold the existing
adversarial coverage — both assert against literal `.env`, not any
`.env.<suffix>` variant.

## Proposed Behavior

Add a small, explicit **exception list** of well-known safe `.env`
template basenames, checked case-insensitively before the broad `.env`
pattern is applied:

```ts
const SAFE_ENV_TEMPLATE_FILENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
])

function isSensitiveFilename(name: string): boolean {
  if (SAFE_ENV_TEMPLATE_FILENAMES.has(name.toLowerCase())) return false
  return SENSITIVE_FILENAME_PATTERNS.some((re) => re.test(name))
}
```

The exception is an **exact basename allow-list**, not a pattern —
`.env.example.local` or `.env.example.production` (someone layering a real
secrets suffix on top of the template name) still matches the existing
broad `.env` pattern and stays denied, because it is not literally one of
the four listed names. Applies identically to both `read_project_file` and
`write_project_file` (one shared function, one call site) — a project that
already has a real `.env.example` becomes readable the same way any other
non-sensitive file already is, and a Coder/DevOps/Documentation proposal to
create or update one can now actually reach the (unchanged) human approval
gate instead of being refused before ever producing a preview.

Every other current denial is completely unchanged: `.env`, `.env.local`,
`.env.production`, `.env.development`, `.env.test`, `*.pem`, `*.key`,
`id_rsa*`, `id_ed25519*`, `*.pfx`, `*.p12` all stay denied exactly as
today, on both read and write.

## Scope

- `packages/mcp/index.ts` — `SENSITIVE_FILENAME_PATTERNS`/`isSensitiveFilename()`
  and the new `SAFE_ENV_TEMPLATE_FILENAMES` set.
- `packages/mcp/project-file-tools.test.ts` — new adversarial coverage
  (the four exempted names on both read and write; confirms a decoy like
  `.env.example.local` still stays denied; confirms `.env`/`.env.local`
  are completely unaffected).

## Safety and Compatibility Constraints

- The exemption is an **exact-basename allow-list**, never a loosened
  regex — this is deliberate: a pattern-based relaxation (e.g. anything
  ending in `example`) would reopen the exact hole this denial exists to
  close. Only these four literal, industry-standard names are exempted.
- This changes what an MCP client (any of the five sharing agents, or the
  external stdio surface) can name as a path — it does **not** change any
  approval-gate behavior. A write to `.env.example` still goes through the
  exact same `dry_run`/preflight/fingerprint/human-approval path every
  other write already does (specs/040/056/083); this spec only removes a
  refusal that happened *before* that path was ever reached.
- Content is still never inspected by this check (unchanged) — the
  exemption is filename-only, matching the existing check's own shape.
  Whatever content a human approves and writes to `.env.example` is their
  own responsibility, exactly as it already is for every other writable
  file in this codebase (this tool has never been a content-scanning
  secrets guard; Security's `scan-secrets` skill is the dedicated tool for
  that, unaffected by this spec).
- No change to `read_project_file`'s behavior for any name outside the
  four exempted ones.

## Out of Scope / Non-Goals

- Widening the exemption to other `.env.*` conventions not in the four
  listed names (e.g. `.env.defaults`, `.env.keys.example`) — can be
  proposed later if a real, named case shows up.
- Any content-based classification (e.g. scanning a proposed `.env.example`
  write for a value that looks like a real secret and refusing on that
  basis) — a materially larger, separate feature.
- Touching the `.pem`/`.key`/`id_rsa`/`id_ed25519`/`.pfx`/`.p12` patterns —
  none of those have an equivalent "safe template" convention.

## Acceptance Criteria

- [x] Explicit approval is recorded before implementation.
- [x] `read_project_file` and `write_project_file` both succeed (subject to
      every other existing check — containment, overwrite flag, etc.) for
      `.env.example`, `.env.sample`, `.env.template`, `.env.dist`
      (case-insensitively).
- [x] `.env`, `.env.local`, `.env.production`, `.env.development`,
      `.env.test`, and a decoy like `.env.example.local` all remain denied,
      unit-tested.
- [x] `bun test` passes. `bun run typecheck` has pre-existing, unrelated
      failures from a concurrent in-progress change to `apps/supervisor` —
      not this spec's files; see verification.md.
- [x] A live check: performed directly against an isolated MCP server
      (write then read-back of `.env.example`, plus the decoy and real
      `.env` both confirmed still denied) — see verification.md.
- [x] `context/worklog.md` gets a dated entry.

## Verification Plan

- Unit: extend `packages/mcp/project-file-tools.test.ts` with both positive
  (four exempted names, read and write) and negative (existing `.env`
  case plus the `.env.example.local` decoy) coverage.
- Live: resubmit the exact request that surfaced this
  (`create the .env.example please` / the narrower reworded version) against
  a running local dev stack with a real provider key, and confirm the
  sensitive-filename refusal no longer occurs.

## Approval Requested

Approval authorizes adding the four-name `SAFE_ENV_TEMPLATE_FILENAMES`
exact-basename exemption to `isSensitiveFilename()` in
`packages/mcp/index.ts`, applied identically to `read_project_file` and
`write_project_file`, plus the corresponding test coverage. It does not
authorize widening the exemption beyond those four names, touching any
other sensitive-filename pattern, or adding content-based classification.
