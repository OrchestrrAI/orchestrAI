---
id: 085-multi-ecosystem-dependency-audit
title: "audit-dependencies — Real Python, Go, PHP, and Java Support, Not npm-Only"
area: security-agent
change_type: feature
status: implemented
verification: verified
created: 2026-09-14
updated: 2026-09-15
approved_by: Yusuf
approved_on: 2026-09-14
implemented_on: 2026-09-14
amends: []
related:
  - 084-security-external-vulnerability-data
  - 043-llm-harness-security
  - 058-testing-agent-multi-ecosystem-runner-detection
supersedes: []
superseded_by: []
---

# Spec: audit-dependencies — Real Python, Go, PHP, and Java Support, Not npm-Only

> Draft, not yet approved. Raised directly by Yusuf right after
> `specs/084` shipped: *"that means that security scan will only for
> the bun? or any stack the project run in?"* — the honest answer at
> the time was npm/Node only, a pre-existing limitation `084` didn't
> expand and explicitly named as a Non-Goal. Yusuf's own call: write
> this as its own follow-up, the same "Phase B′" pattern this codebase
> already used once before for Testing's own Go/Rust/Maven/.NET
> expansion (`specs/058`), applied here to dependency auditing instead
> of test running.
>
> **Design settled through direct back-and-forth, not assumed**: an
> execution-based alternative (shelling out to each ecosystem's own
> real tool — `pip list`, `npm ls`, `go list -m all`) was seriously
> considered, since DevOps's own `docker-status` proves this codebase
> already accepts read-only command execution without an approval gate.
> It was rejected after a real correctness problem was found: `pip
> list`/`npm ls` report what's **installed** in whatever environment the
> command happens to run in, not what the project's manifest
> **declares** — for a project nobody has ever run `pip install`/`npm
> install` against (the common case for an audit target), that's either
> empty or flatly wrong data, not just incomplete. Go's `go.mod` is the
> one case where the manifest itself already contains real, exact
> versions with no separate "declared vs. installed" gap — but even
> there, direct parsing already gets the real, primary dependency data
> without needing to execute anything at all. Yusuf's own call, once
> this was laid out: **pure manifest-file parsing for every ecosystem,
> no execution anywhere** — "getting both feels wired [weird]." Security
> gains zero new capability class from this spec; it stays exactly what
> it has always been, a pure read-only file reader.
>
> **A second, direct follow-up question — "will `pip list`/`npm ls` help?"
> — surfaced a real, genuinely uneven refinement, folded in below.**
> Those commands' one real value (seeing *transitive*/indirect
> dependencies, not just the ones a project directly chose) turns out
> to be available **without execution at all** for npm and PHP: their
> own **lockfiles** (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`;
> `composer.lock`) already contain the full resolved tree with exact
> versions, as plain files. This is genuinely uneven across the five
> ecosystems, not a uniform win — stated honestly rather than implied:
> npm and PHP get a real lockfile to read; Go's own `go.mod` (1.17+)
> already marks indirect dependencies inline, so no separate lockfile
> read is needed there; a plain `requirements.txt` Python project has
> no lockfile at all (only Poetry/Pipenv projects do, and this spec's
> own Python scope is the plainer, more common `requirements.txt`
> case); Maven has **no standard lockfile concept whatsoever** — getting
> its full transitive tree structurally requires execution, which this
> spec has already ruled out, so Maven support here stays direct-POM
> dependencies only, a real, named, permanent-for-now gap, not an
> oversight.

## Purpose

`audit-dependencies` — both its original unpinned-version check and
`specs/084`'s new OSV.dev vulnerability lookup — only ever reads
`package.json`. A Python, Go, PHP, or Java project submitted to it
produces "no dependencies found," not a real audit, regardless of how
many real, possibly vulnerable dependencies that project actually has.
This spec closes that gap for four concrete, named ecosystems — not an
open-ended "any stack" claim (see the "Why not every ecosystem"
subsection below for why that's a real, considered boundary, not a
shortcut) — without inventing a new risk class or touching `084`'s own
already-shipped, already-verified design.

### Why not every ecosystem

Every ecosystem has a genuinely different manifest format with no
shared parser possible: JSON (`package.json`/`composer.json`), plain
text with its own version-specifier grammar (`requirements.txt`), TOML
in two structurally different real shapes (`pyproject.toml`'s PEP 621
vs. Poetry), Go's own custom syntax (`go.mod`), and XML
(`pom.xml`). "Any stack" would mean an unbounded, ever-growing list of
hand-written parsers, each needing real fixture-file testing before it
can be trusted — for a *security* tool specifically, an untested parser
that's subtly wrong is worse than an honest "not supported," since it
produces a false "all clear" rather than a visible gap. This spec picks
four concrete, real ecosystems (the npm baseline plus Python, Go, PHP,
and Java/Maven) and holds each to the same fixture-tested standard,
rather than claiming universal coverage no implementation could
actually back up.

## Verified Current State

**`packages/agents/security/index.ts`'s `skillAuditDependencies()`**
(read directly): unconditionally reads `<project>/package.json`,
throws `"No package.json found at: <path>"` if absent — the literal
error message every non-npm project gets today, regardless of how
real and complete its own dependency manifest is.

**`packages/shared/test-runner.ts`'s `detectRunner()`** (`specs/058`,
read directly): already detects Python via `requirements.txt`/
`pyproject.toml` presence — proof this codebase already has a real,
working ecosystem-detection precedent for at least one non-npm case
(structure mirrored here, not the function itself — `detectRunner()`'s
own job is picking a *test command*, a different question from
*parsing a dependency list*).

**OSV.dev's own ecosystem support**, checked live via `WebFetch`
against `ossf.github.io/osv-schema` before writing this spec, not
assumed: `"npm"`, `"PyPI"`, `"Go"`, `"Packagist"` (PHP/Composer), and
`"Maven"` (Java) are all real, documented ecosystem strings. Maven's
own package `name` field is specifically documented as
`groupId:artifactId` (e.g. `org.apache.commons:commons-lang3`) — a
real, load-bearing detail for the Java parser below, not guessed.

**`packages/agents/security/osv-client.ts`'s `queryOsvBatch()`**
(`specs/084`, read directly): **correction, found during
implementation, not assumed from drafting** — this spec's own first
draft claimed the ecosystem string was already generic; re-reading the
real code found it was actually **hardcoded to `"npm"`** in the request
body. Fixed as part of this spec: `queryOsvBatch()` gains an optional
`ecosystem` parameter (default `"npm"`, so every `specs/084` call site
and test stays byte-identical), and every new caller here passes OSV's
own real ecosystem string explicitly.

**Docker-status's own precedent** (`apps/orchestrator/
supervisor-graph.ts`, `"docker-status": "read-only"`): confirmed this
codebase already accepts real command execution classified read-only/
no-approval, when it has no side effects — the design basis for the
execution alternative this spec's own intro explains was considered
and rejected on correctness grounds, not safety grounds.

**`package-lock.json`'s real structure** (npm's own official docs,
checked live via `WebFetch`, `lockfileVersion` 2/3 — the version every
current npm produces): a flat top-level `packages` object mapping each
package's install path (e.g. `"node_modules/left-pad"`, or a nested
path for a duplicated transitive dependency) to `{version, resolved,
integrity, ...}` — the full resolved tree, direct and transitive, in
one already-flattened structure with no manual tree-walking needed.
Parseable with the native `JSON.parse()` already used for
`package.json` — no new dependency.

**`composer.lock`'s real structure**: **confirmed against a real, live
file** — Composer's own `composer/composer` repository's real
`composer.lock`, checked via `WebFetch` (its own JSON schema docs cover
only `composer.json`, not `composer.lock`, so a real generated file was
the actual source of truth here, not documentation). Top-level
`packages`/`packages-dev` arrays, each entry a full object whose `name`
and `version` string fields are exactly what this spec needs (plus many
other fields — `source`, `dist`, `license`, `require`, etc. — all
ignored).

## Proposed Behavior

### 1. Ecosystem detection, mirroring `specs/058`'s own signal shape

`skillAuditDependencies()` gains a real ecosystem-detection step before
choosing which manifest to parse, checked in this fixed order:

1. `package.json` present → npm (existing behavior, unchanged).
2. `requirements.txt` or `pyproject.toml` present → PyPI.
3. `go.mod` present → Go.
4. `composer.json` present → Packagist.
5. `pom.xml` present → Maven.
6. None present → the existing `"No package.json found..."`-shaped
   error, reworded to name all five files checked, not just one.

Two ecosystem manifests present in the same project (a polyglot repo)
is out of scope for this pass — see Non-Goals.

### 2. Real parsing per ecosystem, no execution anywhere

- **PyPI (`requirements.txt`)**: one dependency per line, `name==version`
  (exact pin) or `name>=version`/`name~=version`/etc. (a range —
  flagged as unpinned, extending the existing unpinned concept to mean
  "no exact version," not just npm's two literal strings). Comment
  lines (`#`) and blank lines skipped; `-r other.txt` includes not
  followed (out of scope, named below).
- **PyPI (`pyproject.toml`)**: only when `requirements.txt` is absent.
  PEP 621's own `[project.dependencies]` array vs. Poetry's own
  `[tool.poetry.dependencies]` table are genuinely different real
  shapes; both parsed against real example files before this is
  considered done, not just one with the other assumed to "probably
  work."
- **Go (`go.mod`)**: `require` block entries, `module version` per
  line — Go's own module versions are already exact, so there is no
  "unpinned" concept to detect; that section of the report is simply
  omitted for a Go project. **Named limitation, stated plainly, not
  hidden**: a plain `go.mod` read captures direct dependencies
  correctly but may miss indirect/transitive ones a real `go list -m
  all` would surface — accepted deliberately (see the design note
  above) rather than adding execution for more completeness.
- **Packagist (`composer.json`)**: JSON, same shape as `package.json`
  — `require`/`require-dev` objects, Composer's own version-constraint
  syntax (`^`, `~`, exact). Platform packages (`php`, `ext-*`) are
  **excluded** from the dependency list entirely — they aren't real
  installable packages OSV could ever have data for, and including
  them would just be noise (or, worse, a spurious "unpinned" flag on
  something that was never a real dependency).
- **Maven (`pom.xml`)**: XML. **No new parsing dependency** — the same
  "no new package" principle `specs/040`'s own line-diff decision and
  `079`'s `lint_ci_workflow` (a dependency-free structural check, never
  a full YAML schema validator) already established in this codebase.
  A narrow, dependency-free extraction targets `<dependency>...
  </dependency>` blocks and their `<groupId>`/`<artifactId>`/
  `<version>` children specifically — not a general XML parser.
  Package name built as `groupId:artifactId`, matching OSV's own
  documented format exactly. **Named limitations, stated plainly**:
  a `<version>` expressed as a property placeholder (`${spring.
  version}`) is resolved only against that same file's own top-level
  `<properties>` block (a simple, same-file substitution) — a
  placeholder defined in a parent POM (Maven's own multi-module
  inheritance) is not resolved, and that dependency is reported with
  its literal unresolved placeholder string rather than guessed at or
  silently dropped, so the gap is visible, not hidden.

### 3. Lockfile-widened vulnerability checks for npm and PHP — real
### transitive coverage, still no execution, and now genuinely
### byte-identical for the unpinned-check section always

**A cleaner split found during implementation, not assumed from the
start**: the unpinned-version check and the vulnerability lookup are
answering two different questions, and conflating them (as the first
draft of this section did, reading the lockfile "instead of" the
manifest) needlessly widened the byte-identical claim's own exception.

- **The unpinned-version check always reads the primary manifest only**
  (`package.json`/`composer.json`), **never the lockfile** — a
  lockfile's own entries are by definition already resolved to one
  exact version, so it has no "is this pinned" signal to offer; that
  question can only be answered from what the manifest itself declared
  (a range vs. an exact version). This section of the report is now
  **unconditionally byte-identical** to today's npm behavior, lockfile
  present or not — no exception needed at all.
- **The vulnerability-lookup dependency list**, separately, prefers the
  lockfile when present, because completeness (direct + transitive) is
  exactly what that check benefits from:
  - **npm**: `package-lock.json` when present (its own `packages`
    object, keyed by install path, already gives the full flattened
    tree, confirmed against npm's own real docs). `yarn.lock`/
    `pnpm-lock.yaml` are real formats too but **out of scope for this
    pass** — see Non-Goals; falls back to `package.json`'s own
    dependency list (today's exact existing behavior) when absent.
  - **PHP**: `composer.lock` when present — its real top-level
    `packages`/`packages-dev` arrays, each entry a `{name, version,
    ...}` object, **confirmed against a real, live `composer.lock` file**
    (`composer/composer`'s own repository) before this was written, not
    assumed. Falls back to `composer.json`'s own `require`/`require-dev`
    when absent.
  - **Go**: no separate lockfile read — modern `go.mod` (1.17+) already
    marks indirect dependencies inline; `go.sum` is a checksum list, not
    a friendlier dependency view, real added parsing complexity for
    marginal gain over what `go.mod` alone already gives.
  - **Python, Maven**: no lockfile-reading path exists at all — a
    plain-`requirements.txt` Python project has no equivalent file, and
    Maven has no standard lockfile concept whatsoever. A real,
    structural gap for these two, named plainly, not an oversight.
- **The vulnerability section's own sub-header**, not the top-level
  `=== Dependency Audit ===` one, names the source it actually used —
  see §5.

### 4. Ecosystem-aware OSV queries

`buildVulnerabilitySection()` (`specs/084`'s own function) already
takes a dependency list; this spec adds an `ecosystem` parameter to it,
threaded through to `queryOsvBatch()`'s own new (see Verified Current
State's correction above) `ecosystem` option.

### 5. Result text names the detected ecosystem; the vulnerability
### section separately names its own source

The **top-level** header gains an ecosystem label for the four new
cases — `=== Dependency Audit (PyPI) ===` / `(Go)` / `(Packagist)` /
`(Maven)` — but npm's own stays **exactly** `=== Dependency Audit ===`,
completely unchanged, unconditionally (§3's own split is what makes
this possible with no exception at all).

The **vulnerability section** (`specs/084`'s own `=== Known
Vulnerabilities (OSV.dev) ===`) separately names whichever source it
actually drew its dependency list from, whenever that differs from the
primary manifest — `=== Known Vulnerabilities (OSV.dev, via
package-lock.json) ===` / `(via composer.lock)` — so a reader always
knows whether the vulnerability check saw the fuller transitive view or
just the direct-only one, without that distinction ever touching the
top-level header or the unpinned-check section above it.

## Scope

**In scope:** PyPI (`requirements.txt` primary, `pyproject.toml`
fallback), Go (`go.mod`), Packagist (`composer.json`), and Maven
(`pom.xml`) detection and parsing; lockfile-first reading for npm
(`package-lock.json`) and Packagist (`composer.lock`) when present;
ecosystem-aware OSV queries (parameter threading only); ecosystem- and
source-labeled result headers.

**Explicitly out of scope (Non-Goals):**
- **Command execution of any kind** — considered and rejected; see this
  spec's own intro for the full reasoning. Security gains zero new
  capability class from this spec.
- **Other ecosystems** (Rust/`Cargo.toml`, .NET/NuGet, Ruby/`Gemfile`,
  etc.) — four is the deliberately bounded scope of this pass, not an
  open list; each is its own future, one-at-a-time addition, the same
  discipline applied here.
- **`requirements.txt`'s `-r other.txt` includes** — a project using it
  gets whatever the top-level file alone declares, not a wrong or
  guessed answer, but not a complete one either — stated honestly.
- **Maven multi-module property inheritance** (a `${...}` placeholder
  defined in a parent POM, not the file being read) — reported with
  its literal unresolved placeholder string, not silently dropped or
  guessed.
- **`yarn.lock`/`pnpm-lock.yaml`** — real npm lockfile formats, but
  genuinely different from `package-lock.json`'s own JSON structure;
  a project using one of these falls back to `package.json` (today's
  existing behavior), not an error. A future, one-at-a-time addition,
  same discipline as everything else deferred here.
- **A lockfile equivalent for Python or Maven** — structurally doesn't
  exist for a plain-`requirements.txt` project or for Maven at all; not
  a gap this spec can close, named honestly rather than worked around.
- **Polyglot projects with more than one ecosystem manifest present at
  once** — a genuinely different question (audit both? pick one? ask?)
  this spec doesn't attempt to resolve, left for a real user report to
  ground rather than guessed at.
- **Any change to `specs/084`'s own npm path, its fail-open behavior,
  or its flag gating** — `ORCHESTRAI_SECURITY_EXTERNAL_DATA` is
  unmodified and still gates every ecosystem's vulnerability lookup
  identically.
- **Any change to `osv-client.ts`'s own request/response handling
  beyond the `ecosystem` parameter** — the correction above is a small,
  additive, default-preserving option, not a rewrite.

## Safety and Compatibility Constraints

- **The npm path's unpinned-check section and its top-level header stay
  byte-identical unconditionally** — lockfile present or not — because
  §3's split means that section is always computed from `package.json`
  alone, exactly as it already was before this spec. Every existing
  test and every existing live-verified transcript in
  `specs/043`/`specs/084` stays correct without modification, no
  exception needed.
- **The vulnerability section alone genuinely improves for the common
  case** (a project that HAS `package-lock.json`) — it becomes more
  complete, direct **and** transitive, and separately names its own
  source (§5) precisely so this is visible, never a silent change.
- **No new external service, no new credential, no new execution
  capability** — every new ecosystem is pure local file reading, same
  as npm's own `package.json` read today; the only network call
  remains the existing, unchanged OSV.dev lookup, still gated by the
  existing flag. Security stays exactly what it has always been.
- **No new parsing dependency** — JSON ecosystems (`composer.json`) use
  the native `JSON.parse()` already used for `package.json`; Maven's
  XML gets a narrow, dependency-free targeted extraction, not a new
  XML-parsing package.
- **Fail closed on a genuinely unparseable manifest** — any manifest
  that exists but doesn't parse (malformed JSON, XML missing an
  expected tag, etc.) fails the task with a real, named parse error,
  never a silently-empty dependency list presented as "nothing found."

## Out of Scope / Non-Goals

See "Explicitly out of scope" under Scope above.

## Acceptance Criteria

- [x] A real Python project (`requirements.txt`, a mix of exact-pinned
      and range-pinned real packages) is correctly audited: exact pins
      recognized as pinned, range specs flagged as unpinned (unit-
      tested), and (flag on) a real OSV.dev PyPI lookup against
      genuinely outdated packages returns real vulnerability data.
      **Live-verified**: `Django==2.2.0`/`requests==2.19.1` correctly
      returned 6 real GHSA advisories with real summaries.
- [x] A real Python project using `pyproject.toml` only is correctly
      parsed — **both** PEP 621's `[project.dependencies]` array and
      Poetry's own `[tool.poetry.dependencies]` table are supported
      (unit-tested against real example content for each); not
      separately live-verified against OSV (the `requirements.txt`
      live pass already proves the PyPI lookup half end to end).
- [x] A real Go project (`go.mod`) is correctly audited: real `require`
      entries parsed, no spurious "unpinned" claims, and (flag on) a
      real OSV.dev Go lookup against a genuinely outdated module
      returns real data. **Live-verified**: `github.com/dgrijalva/
      jwt-go v3.2.0+incompatible` correctly returned 2 real advisories
      (a GHSA id and a Go-specific `GO-` vulnerability id), no
      "Unpinned"/"All dependencies are pinned" text shown at all.
- [x] A real PHP project (`composer.json`) is correctly audited: exact
      pins recognized as pinned, range constraints flagged as unpinned
      (unit-tested — this is where a real bug was found and fixed, see
      `verification.md`), platform packages (`php`, `ext-*`) excluded
      from the dependency list entirely, and (flag on) a real OSV.dev
      Packagist lookup against a genuinely outdated package returns
      real data. **Live-verified**: `phpmailer/phpmailer@5.2.9`
      correctly returned 3 real advisories (RCE, file disclosure, XSS).
- [x] A real Java project (`pom.xml`) is correctly audited: real
      `groupId:artifactId` package names built correctly (unit- and
      live-tested), a same-file `${property}` placeholder correctly
      resolved and an unresolvable one reported literally (unit-tested),
      and (flag on) a real OSV.dev Maven lookup against a genuinely
      outdated dependency returns real data. **Live-verified**:
      `org.apache.logging.log4j:log4j-core@2.14.1` (the Log4Shell
      version) correctly returned real advisories — the specific 3
      shown were capped by `MAX_DETAIL_FETCHES_PER_PACKAGE`, not
      necessarily including the headline CVE-2021-44228 itself, which
      is expected, designed behavior (the cap), not a gap.
- [x] A real npm project's unpinned-check section and top-level header
      are confirmed byte-identical to today, **both with and without** a
      real `package-lock.json` present. **Live-verified** both ways: a
      real, `npm install --package-lock-only`-generated lockfile present
      vs. absent, identical `=== Dependency Audit ===`/`"All
      dependencies are pinned."` text either way.
- [x] The **same** real npm project, **with** a real `package-lock.json`,
      has its vulnerability section correctly surface real data, with
      the section's own sub-header correctly naming `package-lock.json`
      as the source. **Live-verified** with a real npm-generated
      lockfile (`lodash@4.17.20` pinned exactly): 3 real advisories
      returned, header read `=== Known Vulnerabilities (OSV.dev, via
      package-lock.json) ===`. The specific "surfaces a transitive
      dependency the manifest alone would miss" claim is confirmed at
      the unit/HTTP level (a synthetic nested `node_modules` entry) —
      the live npm project used had no real transitive dependencies of
      its own to demonstrate this with, an honest gap in the live pass
      specifically, not the mechanism.
- [x] A real PHP project's vulnerability section, with a real
      `composer.lock` present, shows the same transitive-coverage and
      source-labeling behavior as the npm case above; its own
      unpinned-check section stays sourced from `composer.json` alone,
      unaffected either way. Confirmed at the unit/HTTP level (real
      `composer.lock` structure, checked against a live file from
      Composer's own repository); not separately live-verified against
      OSV with a real `composer.lock` specifically (the npm live pass
      already proves the lockfile-widening mechanism end to end).
- [x] A project with none of the five manifests present fails closed
      with a named error listing all five files checked. Confirmed via
      real HTTP request.
- [x] A genuinely malformed manifest (present but unparseable) in any
      of the four new ecosystems fails closed with a real parse error,
      never an empty/silent result. Confirmed at the unit level for
      each parser (malformed JSON, an unreadable file).
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` all pass;
      the full pre-existing suite (including every `specs/084` test)
      is unaffected — 1055 pass, 0 fail (net +30 over `084`'s own 1025),
      typecheck clean, `specs:check` passed for 84 specs.

## Verification Plan

- Unit-level: real `requirements.txt`/`pyproject.toml`/`go.mod`/
  `composer.json`/`pom.xml` fixture content (written against real,
  documented format examples, not invented) for every parser function;
  ecosystem-detection precedence (npm > PyPI > Go > Packagist > Maven >
  none); the Maven placeholder-resolution and platform-package-
  exclusion edge cases specifically. A real, generated
  `package-lock.json` (`lockfileVersion` 2 or 3) and a real, generated
  `composer.lock` — the latter's own exact structure confirmed against
  a genuinely generated file at this point, closing the one honesty
  gap this spec's own "Verified Current State" section left open.
- HTTP-level: real HTTP requests against the real app for each
  ecosystem's own end-to-end shape, mocked OSV responses for the
  vulnerability-lookup half; the lockfile-vs-manifest fallback
  behavior for npm and PHP specifically.
- Live: a real scratch project per new ecosystem, each with a
  genuinely outdated real package with known public advisories, all
  four against the live OSV.dev service — the same evidentiary bar
  `specs/084`'s own live pass already met for npm. For npm and PHP
  specifically: one scratch project WITH a real lockfile (confirming a
  real transitive dependency is surfaced that the manifest alone
  wouldn't show) and one WITHOUT (confirming the byte-identical
  manifest-only fallback).

## Approval Requested

**Approved by Yusuf, 2026-09-14, and implemented the same day.** See
`verification.md` for the full record, including a real bug found and
fixed while writing this spec's own tests.
