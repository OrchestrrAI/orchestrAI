---
id: 100-document-api-grounded-llm-route-discovery-fallback
title: "document-api Gains a Grounded LLM Route-Discovery Fallback for Non-JS/TS Files"
area: documentation
change_type: enhancement
status: implemented
verification: verified
created: 2026-09-15
updated: 2026-09-20
approved_by: Yusuf
approved_on: 2026-09-20
implemented_on: 2026-09-20
amends:
  - 041-llm-harness-documentation
  - 036-document-api-path-fallback
related:
  - 082-code-review-agent
  - 081-testing-write-tests-skill
  - 085-multi-ecosystem-dependency-audit
supersedes: []
superseded_by: []
---

# Spec: document-api Gains a Grounded LLM Route-Discovery Fallback for Non-JS/TS Files

> Status: **DRAFT — awaiting review.** Live-caught by Yusuf, 2026-09-15,
> on the same real scratch PHP project `specs/099` used to fix
> `analyze-project`'s ecosystem awareness: `document-api` failed outright
> against a Laravel-style PHP router. Yusuf's own question —
> *"cant the llm help here? should i make it by echo system?"* — is what
> this spec answers: yes, but only as a **grounded fallback**, never a
> replacement for the existing deterministic scan.

## Purpose

`packages/agents/documentation/index.ts`'s `scanApiRoutes()` finds real
route registrations via one fixed regex:

```ts
const routeRegex = /app\.(get|post|put|delete)\(\s*["'`]([^"'`]+)["'`]/i
```

This structurally recognizes only Express/Hono-style JavaScript/
TypeScript route registrations (`app.get("/x", ...)`). It has zero
awareness of:

- **PHP** (Laravel `Route::get('/x', ...)`, Slim `$app->get('/x', ...)`)
- **Python** (Flask `@app.route("/x")`, FastAPI `@app.get("/x")`)
- any other web framework's own routing syntax

`DOCUMENT_API_ENTRY_CANDIDATES` (the conventional-entry-file fallback
from `specs/036`) is also an 8-entry, `.ts`-only list (`index.ts`,
`src/index.ts`, `app.ts`, …) — a project with no `.ts` entry file at all
(a pure PHP or Python project) never even reaches candidate matching;
an explicit path is required, and once read, the regex above still
finds nothing.

The real, live-caught consequence: a real PHP project's `document-api`
request against an explicit path (`routes/web.php`) completed with `No
Hono route registrations found (app.get/post/put/delete).` — technically
correct (there genuinely are no Hono-style registrations in that file)
but useless: the file has real routes, just written in a syntax this
scan was never built to recognize.

## Current behavior

- `scanApiRoutes(content)` — one fixed regex, JS/TS Express/Hono-shaped
  route registrations only. Runs unconditionally, regardless of harness
  flag state (`ORCHESTRAI_DOCUMENTATION_LLM_HARNESS`).
- `resolveDocumentApiTarget()` (`specs/036`) — candidate-file fallback is
  `.ts`-only; an explicit absolute path in the task text always wins and
  bypasses candidate selection entirely.
- `computeApiDocOrHarness()` — when the harness flag is on, always calls
  `runApiDocHarness()` with `scanApiRoutes()`'s own output as the
  **authoritative, closed route list** ("do not add routes beyond this
  list, and do not omit any of them") — including when that list is
  empty. An empty list currently still reaches the harness call
  unconditionally; this spec does not change that pre-existing edge
  case for the genuine "this file really has zero routes" case (see Non-
  Goals).
- Route **discovery** itself (as opposed to *writing about* already-
  discovered routes) has never involved the model at all, by design —
  `specs/041`'s own stated reasoning: `scanApiRoutes()` "already finds
  real routes reliably via a narrow regex — no hallucination risk," so
  the harness was scoped to *documenting* a given list, never
  *discovering* one.

## Proposed behavior

**Deterministic-first, LLM-as-grounded-fallback** — the same shape this
codebase already uses for DevOps's own `run-command` skill
(`specs/080`: an explicit, parseable command always wins with no model
call at all; only its absence, and only with the harness on, reaches a
model). Applied here:

1. `scanApiRoutes()` is **completely unchanged** — still the first and
   only route-discovery path for the common JS/TS/Express/Hono case,
   zero added cost, zero added risk for the case this scan already
   handles well.
2. **Only when `scanApiRoutes()` finds zero routes in the resolved
   target file**, and **only when `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS`
   is already on** (default-on per `specs/077`, so this is reachable by
   default, not a new opt-in surface), a new **grounded LLM route-
   discovery step** runs: the model is given the real file's already-
   read content directly (no extra `read_project_file` round trip — the
   content is already in hand from the existing scan) and asked to
   identify any real route registrations it can find, in whatever
   language/framework the file is actually written in.
3. **Grounding, enforced structurally, the same style as `specs/082`'s
   diff-grounding and `specs/081`'s write-tests identifier-grounding**:
   every proposed route's `route` string must occur as a literal
   substring of the real file content handed to the model. A response
   containing even one ungrounded route triggers the same bounded
   retry-with-feedback shape every harness in this codebase already
   uses (naming exactly which proposed route couldn't be found in the
   file); exhausted retries **salvage only the grounded routes** already
   returned in an earlier attempt within the same run when at least one
   exists, mirroring `specs/082`'s own "don't discard a real finding to
   punish one hallucinated one" precedent — with zero grounded routes
   ever proposed across every attempt, discovery fails closed to an
   **empty list**, which flows into the exact existing "no routes found"
   / empty-authoritative-list behavior, never a guessed or fabricated
   route.
4. Discovered routes are fed into the **existing, unmodified**
   `runApiDocHarness()` exactly as `scanApiRoutes()`'s own output already
   is today — as the authoritative route list in the system prompt. No
   change to how the final documentation is written, only to how the
   route list reaching that step was produced.
5. **Harness off, or misconfigured**: discovery is never attempted —
   `scanApiRoutes()` finding zero routes produces the exact pre-100
   behavior (`buildApiDoc()`'s "No Hono route registrations found"
   message via the deterministic path, or the existing
   flag-set-but-misconfigured fail-closed error via the harness path) —
   byte-identical regression, confirmed by test.

### Why a fallback, not a redesign

`specs/041`'s own "discovery stays deterministic, no hallucination risk"
reasoning is **not being silently reversed** — it's being explicitly,
narrowly amended for exactly the case it never covered: a file the
regex was never built to understand at all, where the deterministic
scan's only possible answer is "zero," indistinguishable between "this
file genuinely has no routes" and "this file has routes in a syntax I
don't recognize." The grounding constraint (§3 above) is what keeps this
change consistent with `041`'s original safety story: every proposed
route must be real, verifiable text already present in the real file —
not the model inventing plausible-sounding endpoints.

## Scope

In scope:
- A new, additive route-discovery step in
  `packages/agents/documentation/llm-harness.ts`, reusing the existing
  `buildHarnessGraph()`/`runHarness()` core (the same generic,
  system-prompt/validator-parameterized shape `runReadmeHarness()`/
  `runApiDocHarness()` already share) with a new JSON-structured
  validator and system prompt.
- Wiring this step into `computeApiDocOrHarness()` in
  `packages/agents/documentation/index.ts`, gated exactly as described
  above.
- Grounding validation (substring-presence check against the real file
  content already in hand — no new tool call).

Out of scope (this spec does not touch):
- `scanApiRoutes()` itself, or its regex.
- `resolveDocumentApiTarget()`/`DOCUMENT_API_ENTRY_CANDIDATES` (the
  `specs/036` candidate-file list) — stays `.ts`-only; an explicit path
  is still required for a non-JS/TS project, unchanged.
- `generate-readme` or any other skill.
- Any other agent.

## Safety constraints

- **No new MCP tool, no new tool access.** Discovery uses the file
  content already fetched by the existing deterministic scan — no
  `read_project_file` tool binding is added for this step.
- **Fail-closed, matching `specs/041`'s own established precedent for
  this harness**: a misconfigured harness (flag on, no/invalid key)
  never silently skips discovery and falls back to the deterministic
  path with no signal — it raises the same named error
  `computeApiDocOrHarness()` already raises today for this condition.
  Discovery is only ever *attempted* when the harness is already
  confirmed configured (the same config object `computeApiDocOrHarness`
  already resolves before calling `runApiDocHarness`).
- **No fabricated routes can reach the written documentation.** Every
  route surviving grounding is a literal substring match against real
  file content — never a plausible-sounding invention. This is the
  load-bearing safety property this spec adds; it is enforced in code
  (a JSON schema plus a substring check), not by prompt wording alone.
- **Harness off means zero behavior change.** This entire fallback path
  is unreachable with `ORCHESTRAI_DOCUMENTATION_LLM_HARNESS=0` — the
  exact pre-100 "no routes found" output is preserved byte-identically.

## Acceptance criteria

- [x] A real PHP file with genuine Laravel-style `Route::get('/x', ...)`
      registrations, harness on: `document-api` correctly discovers and
      documents the real routes, never a fabricated one. **Live-verified**
      against a real Gemini deployment — see verification.md.
- [x] The same PHP file, harness off (`=0`): behavior is byte-identical
      to before this spec (`buildApiDoc()`'s "No Hono route
      registrations found" message). **Live-verified.**
- [x] A genuine JS/TS/Express/Hono file with real routes: `scanApiRoutes()`
      finds them as before, discovery is never invoked. Proven
      structurally rather than by call-count spy: `runApiDocRouteDiscoveryHarness`
      has exactly one production call site in the entire codebase
      (`index.ts`'s `if (routes.length === 0)` branch), confirmed by a
      repo-wide grep — a stronger guarantee than a per-call spy, since it
      rules out any other path reaching it, not just the one under test.
      Also live-confirmed: a real JS/TS file with one real route produced
      a single-round-trip response document, never the PHP-shaped
      discovery prompt.
- [x] A file with genuinely zero routes in any language/framework
      (e.g. a plain utility module with no routing code at all),
      harness on: discovery is attempted, finds nothing grounded, and
      the task completes with the same "no routes found" shape — never
      a fabricated route. Unit-tested (`llm-harness.test.ts`).
- [x] A forced ungrounded-route response (a route string that does not
      appear in the real file content) triggers retry-with-feedback
      naming the specific ungrounded route; exhausted retries with at
      least one grounded route from an earlier attempt salvage that
      route; exhausted retries with zero grounded routes ever fail
      closed to an empty list. Unit-tested (`llm-harness.test.ts`).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass.
- [x] Every pre-existing test in the affected files passes unmodified.

## Non-goals

- Expanding `scanApiRoutes()`'s own regex to recognize additional
  syntaxes deterministically (e.g. a second hand-written regex for
  Laravel) — the grounded LLM fallback is deliberately the chosen
  mechanism instead, since a framework-specific regex list would grow
  unboundedly (Slim, FastAPI, Flask, Rails, Django, ASP.NET, each its
  own syntax) where one grounded model call generalizes.
- Expanding `DOCUMENT_API_ENTRY_CANDIDATES` to non-`.ts` conventional
  filenames (e.g. `routes/web.php`, `app.py`) — an explicit path remains
  required for a non-JS/TS project; a separate, later spec if this
  becomes a real, live-caught gap of its own.
- Changing the pre-existing behavior for a file where
  `scanApiRoutes()` already finds zero routes and the harness is on
  (the existing unconditional `runApiDocHarness()` call with an empty
  authoritative list) — this spec adds a discovery attempt *before*
  that call in the zero-routes case, but does not otherwise change what
  happens once discovery itself also finds nothing.
- Any change to `generate-readme`, DevOps, Security, Code Review, Coder,
  or Testing.

## Verification plan

- Unit: new tests in `packages/agents/documentation/llm-harness.test.ts`
  for the new discovery validator (grounded acceptance, ungrounded
  rejection + retry-with-feedback wording, exhausted-retries salvage and
  full-failure-to-empty-list cases) and in
  `packages/agents/documentation/index.test.ts` (or a new
  `document-api-route-discovery.test.ts`) for the gating logic (harness
  off never invokes discovery; JS/TS-with-real-routes never invokes
  discovery; PHP-with-real-routes invokes discovery and documents them).
- `bun run typecheck`, `bun run specs:catalog`/`specs:check`.
- Live, once real Anthropic/Gemini credentials are available: the exact
  real PHP scratch project from `specs/099`'s own live pass (or a fresh
  equivalent), a real `document-api` request against its router file,
  confirming real discovered routes appear correctly in the generated
  documentation, and the harness-off regression re-confirmed against the
  same project.
