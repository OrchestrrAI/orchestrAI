# Verification: specs/100 — document-api Grounded LLM Route-Discovery Fallback

## What changed

**`resolveAndScanApiTarget()`** (`packages/agents/documentation/index.ts`)
now also returns the already-read real file `content`, alongside the
existing `targetPath`/`targetDir`/`targetName`/`endpoints` — no extra
read, just surfacing what was already fetched so the new discovery step
doesn't need a second `read_project_file` round trip.

**`computeApiDocOrHarness()`** gains one new branch: when
`scanApiRoutes()` finds zero routes (`endpoints.length === 0`) *and* the
harness is already confirmed configured (the existing `isHarnessFlagSet()`
+ `readLlmHarnessConfig()` checks, unchanged), it calls the new
`runApiDocRouteDiscoveryHarness()` before the existing, unmodified
`runApiDocHarness()` call. `scanApiRoutes()` itself is untouched — still
the first and only path for the common JS/TS/Express/Hono case.

**`runApiDocRouteDiscoveryHarness()`** (`packages/agents/documentation/llm-harness.ts`)
reuses the existing `buildHarnessGraph()`/`runHarness()` core unchanged
— same tool-call loop, same read-only tool set, same recursion-limit
handling — with a new JSON-structured system prompt and validator. The
real file content is embedded directly in the prompt (no extra tool
call needed for the common case, though the model may still call
`read_project_file` if it genuinely wants to check something else — the
tool stays bound, just not required).

**Grounding + salvage**, implemented entirely inside the `validate()`
closure passed to the existing generic core — no change to
`buildHarnessGraph()`/`runHarness()` themselves: every proposed route's
`route` string must be a literal substring of the real file content.
An ungrounded proposal is rejected (triggering the existing generic
retry-with-feedback machinery) but its grounded subset is remembered in
a closure variable (`bestGrounded`) *before* the rejection is returned.
On exhausted retries, the generic core discards the last (invalid)
response and returns `null` — the caller then falls back to
`bestGrounded`, the largest fully-grounded subset seen across any
attempt. Zero grounded routes ever produced degrades to an empty array,
flowing into the exact same "no routes found" shape `scanApiRoutes()`
itself already produces for a genuinely route-free file.

Discovered routes feed into the existing, unmodified `runApiDocHarness()`
exactly as `scanApiRoutes()`'s own output already does — no change to how
the final documentation is written.

## Test results

- `bun test` (full suite): **1208 pass, 0 fail, 2 skip** (pre-existing,
  unrelated) — net **+7** over the pre-100 baseline of 1201.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog` / `bun run specs:check`: pass, 101 specs.
- New coverage in `packages/agents/documentation/llm-harness.test.ts`
  (7 new tests): a fully-grounded first-attempt response; a genuinely
  route-free file producing an empty list; an ungrounded route
  triggering retry-with-feedback that then succeeds; exhausted retries
  salvaging the largest grounded subset seen across attempts (a mixed
  grounded+ungrounded first attempt, a worse fully-ungrounded second
  attempt — the *first* attempt's real grounded route must survive);
  exhausted retries with zero grounded routes ever failing closed to an
  empty list; malformed JSON triggering the same retry-with-feedback
  path as any other invalid response; the model optionally calling
  `read_project_file` (bound, not required).
- Every pre-existing test in `packages/agents/documentation/` passes
  unmodified — confirmed by running the package's full test suite both
  before and after this change.

## Live verification

A real Gemini deployment (`.orchestrai/config.env`'s real key, the same
standing authorization used for specs/101/102's own live passes this
session — same real key, gitignored, confirmed via `git check-ignore`).
`ORCHESTRAI_DOCUMENTATION_LLM_MODEL` overridden to `gemini-3.5-flash-lite`
per-process (the saved config's `gemini-2.5-flash-lite` was already
found stale/rejected by the real API earlier this session).

**Scenario 1 — real PHP Laravel routes, harness on.** A real scratch
file (`routes/web.php`) with three genuine `Route::get`/`Route::post`/
`Route::delete` registrations, one with a real `{id}` path parameter.
Dispatched a real `document-api ... save to ...` request. The real
completed preview:

```
### List all users
GET /users
Retrieves a list of all users.
Controller Action: UserController@index
...
### Create a new user
POST /users
...
### Delete a user
DELETE /users/{id}
...
Parameters: id | integer/string | path | The unique identifier...
```

All three real routes discovered and documented correctly, including
the real path parameter — never a fabricated route. Approved: the real
file on disk matched the preview byte-for-byte (`diff`-equivalent
manual comparison, both show the identical markdown).

**Scenario 2 — the same PHP file, harness off (`=0`).** A fresh
`documentation-agent` process (confirmed via `/healthz`'s `tasks: 0`,
after correcting an initial stale-process false start where a leftover
process was still bound to port 3004 from Scenario 1). The identical
write request against the identical file produced:

```
"content":"# API Reference — ...routes\\web.php\n\nNo Hono route registrations found (app.get/post/put/delete).\n"
```

Byte-identical to the pre-100 deterministic output — confirming the
new fallback path is genuinely unreachable with the harness off, not
merely unused. Rejected (no file written), confirmed the target file
was never created.

**Scenario 3 — a genuine JS/TS/Express file with a real route, harness
on.** A real `index.ts` with one real `app.get("/health", ...)`
registration. Dispatched the identical request shape. The real
completed preview correctly documented only the one real `/health`
route, in a single model round trip (no discovery-shaped prompt/response
in the exchange) — consistent with `scanApiRoutes()` already finding the
route deterministically and the `routes.length === 0` gate never firing.
Rejected (no file written).

**A pre-existing, unrelated routing property surfaced along the way,
not a specs/100 regression**: `document-api`'s harness is only reachable
via the write path (a "save to"/"write to" clause in the task text) —
a bare read-only `document-api` request calls `skillDocumentApi()` →
`computeApiDoc()` directly, never `computeApiDocOrHarness()`, regardless
of harness state. Confirmed by reading `processTask()` directly
(`NEEDS_APPROVAL`/`isWriteApi` gating). This predates specs/100 and is
out of this spec's scope — Non-Goals excludes any change to skills other
than the new discovery gating itself.

## Known limitations

- The "JS/TS with real routes never invokes discovery" acceptance
  criterion is proven structurally (a repo-wide grep confirming
  `runApiDocRouteDiscoveryHarness` has exactly one production call
  site, itself gated on `routes.length === 0`) rather than via a
  per-call spy/counter — a stronger, not weaker, guarantee, but a
  different verification shape than the spec's own suggested technique.
  Named explicitly rather than silently substituted.
- Python (Flask/FastAPI) and other non-PHP frameworks were not
  independently live-tested this session — the mechanism is
  language-agnostic by design (the model is asked to recognize whatever
  syntax is actually present, not matched against a PHP-specific
  pattern), and the grounding constraint applies identically regardless
  of source language, so this is judged a reasonable, disclosed gap
  rather than a blocking one.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

**Correction, 2026-09-20 — discovery itself now has a narrow, grounded
LLM fallback.** `specs/100-document-api-grounded-llm-route-discovery-
fallback/spec.md` (implemented, **verified**) amends the "route
discovery stays fully deterministic either way" claim above: it was
true when written, but only ever covered the JS/TS/Express/Hono case
`scanApiRoutes()`'s one fixed regex recognizes. Live-caught by Yusuf,
2026-09-15, on a real PHP Laravel project (the same one `specs/099` used
to fix `analyze-project`'s ecosystem awareness): `document-api` against
`routes/web.php` completed with `"No Hono route registrations found"` —
technically correct, uselessly so, since the file has real routes
written in `Route::get('/x', ...)` syntax the regex was never built to
recognize. Yusuf's own question, *"cant the llm help here? should i
make it by echo system?"*, is what this spec answers: yes, but only as
a grounded fallback, never a redesign — `scanApiRoutes()` itself is
completely unchanged and still runs first, unconditionally, for every
request.

Only when `scanApiRoutes()` finds **zero** routes, and only when the
harness is already confirmed configured (default-on per `specs/077`, so
reachable without a new opt-in), `packages/agents/documentation/
llm-harness.ts`'s new `runApiDocRouteDiscoveryHarness()` gets one
attempt: the model is handed the real file's already-read content
directly (no extra `read_project_file` round trip for the common case,
though the tool stays bound if it genuinely wants to check something
else) and asked to find real route registrations in whatever language/
framework the file actually uses. **The grounding constraint is what
keeps this consistent with `041`'s own original safety story, not a
relaxation of it**: every proposed route's path must occur as a literal
substring of the real file content — enforced in code (a JSON schema
plus a substring check), not by prompt wording alone. An ungrounded
proposal triggers the same bounded retry-with-feedback shape every
harness in this codebase already uses, naming the specific offending
route; on exhausted retries, the largest fully-grounded subset seen
across any attempt is salvaged (mirroring `specs/082`'s own "don't
discard a real finding to punish one hallucinated one" precedent,
implemented here as a closure variable the validator updates on every
attempt before it returns rejection) — with zero grounded routes ever
produced, this degrades to an empty array, flowing into the exact same
"no routes found" shape `scanApiRoutes()` itself already produces for a
genuinely route-free file. Discovered routes feed into the existing,
unmodified `runApiDocHarness()` exactly as `scanApiRoutes()`'s own
output already does — no change to how the final documentation is
written, only to how the route list reaching that step was produced.

`DOCUMENT_API_ENTRY_CANDIDATES` (`specs/036`'s `.ts`-only conventional-
entry-file list) is untouched — an explicit path is still required for
a non-JS/TS project. Also untouched, and named explicitly as a
pre-existing, unrelated property found while live-verifying this spec,
not a regression it introduces: `document-api`'s harness (of any kind,
including this new fallback) is only reachable via the **write** path
(a "save to"/"write to" clause in the task text) — a bare read-only
`document-api` request always calls the deterministic
`computeApiDoc()` directly, regardless of harness state.

**Live-verified against a real Gemini deployment**: a real scratch PHP
project with three genuine Laravel `Route::get`/`post`/`delete`
registrations (one with a real `{id}` path parameter) — `document-api`
correctly discovered and documented all three, never a fabricated
route, and the approved write landed on disk byte-identical to the
preview. The identical request against the identical file with the
harness explicitly off (`=0`) reproduced the exact pre-100 "No Hono
route registrations found" message, confirming the new fallback is
genuinely unreachable, not merely unused, when disabled. A real JS/TS
file with one real `app.get("/health", ...)` route correctly used only
the existing single-round-trip path, confirming the new discovery step
is never reached when `scanApiRoutes()` already found something — also
provable structurally, since `runApiDocRouteDiscoveryHarness` has
exactly one production call site in the entire codebase (a repo-wide
grep), itself gated on `routes.length === 0`. See `specs/100`'s own
`verification.md` for the complete transcript.

See specs/111-testing-documentation-routing-fixes/verification.md for the relocated narrative covering this checkpoint.

See specs/103-deep-project-analysis/verification.md for the relocated narrative covering this checkpoint.
