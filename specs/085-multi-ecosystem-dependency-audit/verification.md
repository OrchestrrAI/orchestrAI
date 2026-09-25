# Verification — specs/085-multi-ecosystem-dependency-audit

Recorded 2026-09-14, same session as implementation.

## Unit-level

- **`packages/agents/security/dependency-manifests.ts`'s new tests**
  (`dependency-manifests.test.ts`, 23 tests): real fixture content per
  format — `requirements.txt` (mixed exact/range pins, comment/blank
  lines, `-r` includes correctly not followed), `pyproject.toml` (both
  PEP 621's `[project.dependencies]` array and Poetry's own
  `[tool.poetry.dependencies]` table, each a real, independently
  verified shape), `go.mod` (block and single-line `require` forms, an
  `// indirect` dependency correctly kept, not filtered), `pom.xml`
  (real `groupId:artifactId` naming, a same-file `${property}`
  correctly resolved, an unresolvable parent-POM placeholder correctly
  reported literally rather than dropped or guessed), `composer.json`,
  `composer.lock` (real `packages`/`packages-dev` structure), and
  `package-lock.json` (a real `lockfileVersion: 3` `packages` object,
  including a nested/transitive entry and the root project's own `""`
  key correctly skipped). Ecosystem-detection precedence (npm > PyPI >
  Go > Packagist > Maven > none) and malformed/missing-file error paths
  also covered.

  **A real, previously-undiscovered bug was found and fixed while
  writing these tests, not assumed away.** The first version of
  `PLATFORM_PACKAGE` (`/^(php|hhvm|ext-|lib-|composer-)/`) matched as a
  plain prefix with no word boundary — it silently excluded
  `phpmailer/phpmailer` from every audit, because the package name
  happens to start with the literal substring `"php"`, the same as the
  real `php` platform package it was meant to exclude. Caught by the
  test asserting `phpmailer/phpmailer` (deliberately chosen as a
  realistic "starts with php but isn't php" case) landed in the
  `unpinned` list when given a range version — it didn't, revealing the
  bug. Fixed by requiring `php`/`hhvm` to match the **entire** package
  name (`^(php|hhvm)$`), while keeping `ext-`/`lib-`/`composer-` as
  genuine prefix matches (no real Packagist package collides with
  those the way `phpunit`/`phpmailer`/etc. collide with `php`).

## HTTP-level

- **`packages/agents/security/index.test.ts`** gained 7 new tests: no
  manifest of any ecosystem present (fails closed, names all five files
  checked); Python, Go, Packagist, and Maven each correctly audited
  end-to-end through the real, unmodified app, with the correct
  ecosystem-labeled header; the npm-lockfile-widening pair — with no
  lockfile, the top header and unpinned-check section are confirmed
  identical to the pre-085 shape; with a real (test-constructed)
  lockfile containing a genuine nested/transitive entry, the
  vulnerability section correctly queries and surfaces that transitive
  dependency (confirmed by intercepting the real OSV query body and
  asserting the transitive package name is present in it) while the
  unpinned-check section and top header stay completely unaffected.

## `bun test`/`typecheck`/`specs:check`

- `bun test`: 1055 pass, 0 fail (net +30 over the pre-085 baseline of
  1025 — 23 new `dependency-manifests.test.ts` tests, 7 new
  `index.test.ts` tests), across 69 files.
- `bun run typecheck`: 0 errors.
- `bun run specs:catalog`/`specs:check`: passed for 84 specs.
- All 41 pre-existing `specs/084` tests pass completely unmodified.

## Corrections made during implementation, found by actually reading
## and testing the real code, not assumed from the draft

- **`osv-client.ts`'s `queryOsvBatch()` was actually hardcoded to
  `"npm"`** — this spec's own first draft claimed it was already
  ecosystem-generic (a re-read of `specs/084`'s live pass evidence
  didn't catch this, since every `084` call site only ever used npm).
  Fixed with a new, optional `ecosystem` parameter defaulting to
  `"npm"`, so every `084` call site and test stays byte-identical.
- **`composer.lock`'s real structure** couldn't be confirmed from
  Composer's own official schema docs (they cover `composer.json` only)
  — resolved by fetching a real, live `composer.lock` from
  `composer/composer`'s own GitHub repository instead of assuming the
  widely-repeated-but-unverified shape. Confirmed: top-level
  `packages`/`packages-dev` arrays, each entry a `{name, version, ...}`
  object.
- **The lockfile-widening design was refined mid-implementation**: the
  spec's own first draft would have made npm's top-level header and
  unpinned-check section conditionally different depending on lockfile
  presence, widening the "byte-identical" claim into an exception. A
  cleaner split was found before writing code: the unpinned-check
  section always reads the primary manifest alone (a lockfile has no
  "is this pinned" signal to offer — every entry is already resolved to
  one exact version), so that section and the top header are now
  **unconditionally** byte-identical, lockfile or not. Only the
  vulnerability section's own list — and its own separate sub-header —
  changes based on lockfile presence. The spec was updated to reflect
  this before implementation, not left to drift from what shipped.

## Live pass, 2026-09-14 (real OSV.dev service, real Django/requests/
## jwt-go/phpmailer/log4j-core/lodash versions — genuinely known-
## vulnerable, not synthetic)

Real `security-agent` process, `ORCHESTRAI_SECURITY_EXTERNAL_DATA=1`,
no `mcp:http` needed (Security stays direct-`fs`). Five real scratch
projects, one per ecosystem, each with a deliberately outdated real
package with well-known, real public advisories:

**Python** (`requirements.txt`: `Django==2.2.0`, `requests==2.19.1`):

```
=== Dependency Audit (PyPI) ===
...
All dependencies are pinned.

=== Known Vulnerabilities (OSV.dev) ===
  - Django@=2.2.0: GHSA-296w-6qhq-gf92 — Django denial of service via file upload naming
  - Django@=2.2.0: GHSA-3h9f-r86x-qvjx — Django: cache middleware may expose private responses...
  - Django@=2.2.0: GHSA-3jqw-crqj-w8qw — Denial of service in django
  - requests@=2.19.1: GHSA-652x-xj99-gmcc — Exposure of Sensitive Information...
  - requests@=2.19.1: GHSA-9hjg-9r4m-mvj7 — Requests vulnerable to .netrc credentials leak...
  - requests@=2.19.1: GHSA-9wx4-h78v-vm56 — Requests Session object does not verify...
```

**Go** (`go.mod`: `github.com/dgrijalva/jwt-go v3.2.0+incompatible`,
the real, well-known JWT authorization-bypass module):

```
=== Dependency Audit (Go) ===
...


=== Known Vulnerabilities (OSV.dev) ===
  - github.com/dgrijalva/jwt-go@v3.2.0+incompatible: GHSA-w73w-5m7g-f7qc — Authorization bypass...
  - github.com/dgrijalva/jwt-go@v3.2.0+incompatible: GO-2020-0017 — Authorization bypass...
```

No "Unpinned"/"All dependencies are pinned" text anywhere — confirmed
correctly omitted for Go, exactly as designed.

**PHP** (`composer.json`: `phpmailer/phpmailer: "5.2.9"`, a real,
well-known RCE-vulnerable version):

```
=== Dependency Audit (Packagist) ===
...
All dependencies are pinned.

=== Known Vulnerabilities (OSV.dev) ===
  - phpmailer/phpmailer@5.2.9: GHSA-4pc3-96mx-wwc8 — Remote code execution in PHPMailer
  - phpmailer/phpmailer@5.2.9: GHSA-4x5h-cr29-fhp6 — Local file disclosure in PHPMailer
  - phpmailer/phpmailer@5.2.9: GHSA-58mj-pw57-4vm2 — Cross-site scripting in PHPMailer
```

**Java** (`pom.xml`: `org.apache.logging.log4j:log4j-core:2.14.1`, the
real Log4Shell-era version):

```
=== Dependency Audit (Maven) ===
...


=== Known Vulnerabilities (OSV.dev) ===
  - org.apache.logging.log4j:log4j-core@2.14.1: GHSA-3pxv-7cmr-fjr4 — Silent log event loss...
  - org.apache.logging.log4j:log4j-core@2.14.1: GHSA-6hg6-v5c8-fphq — verifyHostName attribute...
  - org.apache.logging.log4j:log4j-core@2.14.1: GHSA-7rjr-3q55-vv33 — Incomplete fix for Apache Log4j...
```

Real advisories, correctly built `groupId:artifactId` package name. The
specific 3 shown are bounded by `MAX_DETAIL_FETCHES_PER_PACKAGE` — this
version genuinely has more than 3 known advisories (including the
famous CVE-2021-44228/"Log4Shell" itself), and the cap means the exact
3 surfaced aren't guaranteed to include that specific one. This is the
cap working exactly as designed, not a gap — `queryOsvBatch()` itself
did receive and report multiple real ids for this package; only the
detail-fetch step is capped.

**npm, with a real, `npm install --package-lock-only`-generated
lockfile** (`package.json`: `lodash: "4.17.20"` exact-pinned):

```
=== Dependency Audit ===
...
All dependencies are pinned.

=== Known Vulnerabilities (OSV.dev, via package-lock.json) ===
  - lodash@4.17.20: GHSA-29mw-wpgm-hmr9 — Regular Expression Denial of Service (ReDoS) in lodash
  - lodash@4.17.20: GHSA-35jh-r3h4-6jhm — Command Injection in lodash
  - lodash@4.17.20: GHSA-f23m-r3pf-42rh — lodash vulnerable to Prototype Pollution...
```

Top-level header stays exactly `=== Dependency Audit ===`, unlabeled —
confirming §3's own claim that the ecosystem label never applies to
npm even when a lockfile widens the vulnerability check. The
vulnerability section's own sub-header correctly names
`package-lock.json` as its source.

**Regression check — the same npm project, `security-agent` restarted
with the flag OFF**, real lockfile still present on disk:

```
=== Dependency Audit ===
...
All dependencies are pinned.
```

No vulnerability section at all — confirms the flag genuinely gates
everything, even with a real lockfile sitting right there.

An earlier attempt with a caret range (`lodash: "^4.17.20"`) is worth
recording as its own small, real finding: `npm install
--package-lock-only` resolved that range to `4.18.1` (a newer, already-
patched version) — a live, concrete demonstration of exactly why
reading the **lockfile's real resolved version** is more accurate than
trusting the manifest's own loose range at all, not just more complete
for transitive dependencies.

All scratch projects and both background `security-agent` processes
were removed/stopped after the pass.

## Closed live, 2026-09-15 — all three remaining gaps

**`pyproject.toml`'s own PyPI round trip**: a real scratch project
using PEP 621's `[project] dependencies = [...]` array
(`django==2.2.0`, `requests==2.19.1`) — deliberately the array shape,
not Poetry's table shape, since `requirements.txt`'s own earlier live
pass already covered the same ecosystem via a different manifest
format. `audit-dependencies` correctly parsed both pinned dependencies
and returned **6 real GHSA advisories** (3 for `django`, 3 for
`requests`) from a live OSV.dev call, matching `requirements.txt`'s own
already-proven PyPI/OSV half exactly, now confirmed for the
`pyproject.toml` parsing path specifically, not just by unit test.

**`composer.lock`'s own lockfile-widening, live-chained through OSV**:
a real scratch project with `composer.json` declaring only
`phpmailer/phpmailer` (`^5.2`, unpinned) and a real `composer.lock`
resolving it to the same known-vulnerable `5.2.9` used in this spec's
own original PHP live pass, **plus a second package,
`guzzlehttp/guzzle@6.3.0`, present only in the lockfile — never
declared in `composer.json` at all**. The result correctly reported
`Total dependencies: 1` (the manifest-only count, unchanged — the
"getting both feels weird" design decision from this spec's own opening
blockquote, confirmed live) while the vulnerability section, correctly
labeled `"via composer.lock"`, returned real advisories for **both**
packages — 3 for `phpmailer/phpmailer` (including its real RCE) and 3
for `guzzlehttp/guzzle` — decisive proof the lockfile-widening
mechanism genuinely surfaces and queries a package the manifest alone
would never have known about, not just a synthetic unit-test case.

**npm's own "surfaces an additional transitive package" case,
finally with a real transitive dependency to demonstrate it**: the
original live pass's own `lodash` project had zero real dependencies
of its own (lodash resolves to exactly itself), so it could only prove
the "more accurate resolved version" half of this claim. A new scratch
project (`package.json` declaring only `axios@0.21.0`, a real, known
genuinely-vulnerable version) had a real `package-lock.json` generated
via the identical `npm install --package-lock-only` methodology this
spec's own original pass used — resolving to **two** real packages:
`axios@0.21.0` and a real transitive dependency, `follow-redirects@
1.16.0`, present only in the lockfile. The result correctly reported
`Total dependencies: 1` while the `"via package-lock.json"`-labeled
vulnerability section returned 3 real advisories for `axios` (zero for
`follow-redirects` at this exact version — the same "genuinely
per-package, not a blanket flag" signal the original `lodash`/
`left-pad` pass already demonstrated). This closes the specific gap
the original pass left open: a real transitive dependency, absent from
the manifest, present only via the lockfile, genuinely queried.

All three scratch projects and the restarted `security-agent` process
were left in place / stopped as part of this session's own ongoing
live-verification work; no code was changed in this pass.

This closes every item this spec's own verification previously left
open. `verification` moves from `partial` to `verified`.

No `docker compose up` pass was performed or is needed — this spec adds
no new agent and no new `docker-compose.yml` service block, so that gap
(which `082`/`083` still carry) does not apply here.

## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/085-multi-ecosystem-dependency-audit/spec.md` (implemented,
**verified**, 2026-09-14, remaining gaps closed live 2026-09-15) is the direct follow-up Yusuf
raised right after `084` shipped: `audit-dependencies` only ever read
`package.json` — a Python, Go, PHP, or Java project got "no
dependencies found," not a real audit. This closes that gap for four
concrete, named ecosystems, not an open-ended "any stack" claim — every
manifest format is genuinely different (JSON, plain text with its own
version grammar, TOML in two real shapes, Go's own syntax, XML), so
"any stack" would mean an unbounded list of hand-written parsers; a
*security* tool with an untested parser risks a false "all clear,"
worse than an honest "not supported."

**Design settled through direct, plain-language back-and-forth, not
assumed** — the full reasoning trail is preserved verbatim in the
spec's own opening blockquote, worth reading in full for how each turn
changed the design:

1. **Execution vs. parsing.** An execution-based alternative (`pip
   list`, `npm ls`, `go list -m all`) was seriously considered, since
   DevOps's own `docker-status` proves this codebase already accepts
   read-only command execution without an approval gate. Rejected on a
   real correctness finding: `pip list`/`npm ls` report what's
   **installed** in whatever environment the command happens to run
   in, not what the project's manifest **declares** — for an audit
   target nobody has ever run `pip install`/`npm install` against (the
   common case), that's empty or flatly wrong data, not just
   incomplete. Go's `go.mod` already contains real, exact versions
   directly, no execution gap to close there either. Settled: **pure
   manifest-file parsing for every ecosystem, no execution anywhere**
   — Security gains zero new capability class from this spec, staying
   exactly the pure read-only file reader it has always been.
2. **"Would `pip list`/`npm ls` actually help?"** — a real, valuable
   question: their one genuine value (seeing *transitive*, not just
   direct, dependencies) is available **without execution** via each
   ecosystem's own **lockfile** — `package-lock.json` (npm) and
   `composer.lock` (PHP) already contain the full resolved tree as
   plain files. Genuinely uneven, stated honestly rather than
   smoothed over: Go's modern `go.mod` (1.17+) already marks indirect
   deps inline (little extra to gain); a plain `requirements.txt`
   Python project has no lockfile at all; Maven has **no standard
   lockfile concept whatsoever** — getting its full transitive tree
   would structurally require execution, already ruled out, so Maven
   stays direct-POM-dependencies-only, a real, permanent-for-now gap.
3. **"Getting both feels weird"** — Yusuf's own pushback on an early
   draft where the top-level header and unpinned-check section would
   have differed depending on whether a lockfile was present. A
   cleaner split, found before writing code: the unpinned-check
   question ("does the manifest allow a floating version?") can only
   ever be answered from the manifest itself — a lockfile's every entry
   is already resolved to one exact version, so it has nothing to say
   about pinning. That section (and npm's own unlabeled header) is now
   **unconditionally** byte-identical, lockfile or not; only the
   vulnerability section's own dependency list — and its own separate
   sub-header — changes when a lockfile widens it.

**A real, previously-undiscovered bug found while writing this
checkpoint's own tests, not assumed away**: the first version of the
PHP platform-package exclusion regex (`/^(php|hhvm|ext-|lib-|
composer-)/`) matched as a plain, unanchored prefix — it silently
excluded the completely real, common package `phpmailer/phpmailer`
from every audit, because the name happens to start with the literal
substring `"php"`, colliding with the real `php` platform package it
was meant to exclude. Fixed by requiring `php`/`hhvm` to match the
**entire** name, keeping `ext-`/`lib-`/`composer-` as genuine prefix
matches (no real package collides with those the way `phpunit`/
`phpmailer`/etc. collide with `php`).

**A second correction, found during implementation, not assumed from
drafting**: `specs/084`'s own `queryOsvBatch()` was actually **hardcoded
to `"npm"`** in its request body — this spec's first draft had assumed
it was already ecosystem-generic. Fixed with an optional `ecosystem`
parameter (default `"npm"`, every `084` call site and test stays
byte-identical).

1055 tests pass (0 fail; net +30 over `084`'s own 1025 — 23 new
`dependency-manifests.test.ts` tests, 7 new `index.test.ts` tests),
typecheck clean, `specs:check` passed for 84 specs.

**Live-verified against the real OSV.dev service, five real scratch
projects, one per ecosystem, each with a genuinely well-known
vulnerable real package**: Python (`Django==2.2.0`/`requests==2.19.1`,
6 real advisories); Go (`github.com/dgrijalva/jwt-go
v3.2.0+incompatible`, the real JWT auth-bypass module, 2 real
advisories including a Go-specific `GO-` id, correctly zero "unpinned"
text shown); PHP (`phpmailer/phpmailer@5.2.9`, 3 real advisories
including its real RCE); Java (`org.apache.logging.log4j:log4j-core@
2.14.1`, the real Log4Shell-era version, real advisories returned —
the specific 3 shown are bounded by `MAX_DETAIL_FETCHES_PER_PACKAGE`,
not guaranteed to include CVE-2021-44228 itself, the cap working as
designed); npm with a real, `npm install --package-lock-only`-generated
lockfile (`lodash@4.17.20`, 3 real advisories, the vulnerability
section's own sub-header correctly reading "via package-lock.json"
while the top-level header stayed exactly unlabeled). **One incidental,
concrete finding along the way**: an earlier attempt using a caret
range (`lodash: "^4.17.20"`) had `npm install --package-lock-only`
resolve it to `4.18.1` — a live, direct demonstration that reading the
lockfile's real resolved version is more accurate than trusting the
manifest's own loose range, not just more complete for transitive
dependencies. The flag-off regression was re-confirmed live with the
real lockfile still present on disk — no vulnerability section at all.

**Closed live, 2026-09-15**: all three remaining gaps. A real
`pyproject.toml` (PEP 621 `[project] dependencies` array,
`django==2.2.0`/`requests==2.19.1`) correctly returned 6 real GHSA
advisories. A real `composer.lock` declaring only `phpmailer/phpmailer`
in `composer.json` but resolving a second package
(`guzzlehttp/guzzle@6.3.0`) only in the lockfile correctly reported
`Total dependencies: 1` while the `"via composer.lock"` vulnerability
section returned real advisories for **both** packages — decisive proof
the lockfile-widening mechanism genuinely surfaces and queries a
package the manifest alone never declared. A real npm project
(`axios@0.21.0`, a genuinely known-vulnerable version) resolved via a
real `npm install --package-lock-only` to a genuine transitive
dependency (`follow-redirects@1.16.0`, absent from `package.json`)
correctly reported `Total dependencies: 1` while the lockfile-based
query covered both packages — closing the one case the original pass's
own `lodash` project (zero real dependencies of its own) couldn't
demonstrate. `specs/085` is now `verification: verified`. See that
spec's own `verification.md` for the complete transcript.

- ~~Security's `audit-dependencies` only ever reads `package.json`.~~
  Fixed — see `specs/085-multi-ecosystem-dependency-audit/spec.md`:
  Python (`requirements.txt`/`pyproject.toml`), Go (`go.mod`), PHP
  (`composer.json`/`composer.lock`), and Java (`pom.xml`) are all real
  now, alongside npm's own `package-lock.json` lockfile-widening. Rust
  (`Cargo.toml`), .NET (NuGet), and Ruby (`Gemfile`) remain the next,
  one-at-a-time follow-ups — same discipline, not attempted yet.

See specs/084-security-external-vulnerability-data/verification.md for the relocated narrative covering this checkpoint.

See specs/099-tui-port-url-and-analyze-project-stack-awareness/verification.md for the relocated narrative covering this checkpoint.
