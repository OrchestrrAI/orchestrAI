## Narrative record (relocated from CLAUDE.md, 2026-09-23, specs/118)

`specs/040-approval-preview-content-diff/spec.md` (implemented,
**verified**). Every write-capable approval preview used to show *that*
a file would be written and *where* — never *what*. That was tolerable
while every write skill was one of a handful of fixed templates a human
could recite from memory; it stopped being tolerable the moment any
component's content could become non-deterministic, which is the whole
premise of the proposed `041`-`043` LLM-agent sequence. This checkpoint
had to land first — none of those can safely ship approving unpredictable
generated content through a params-only card, which is a rubber stamp,
not a review.

`ApprovalPreview` (`packages/shared/approval.ts`) gains two optional
fields: `content` (the exact content that will be written) and
`previousContent` (the file's current content, present only when
overwriting). Both are always the full, uncapped value server-side — any
size limit is a client-side rendering decision, never applied to what's
stored or returned by `GET /tasks/:id`. **The load-bearing correctness
property, enforced by construction, not convention**: content is
computed once, at preview time, and reused verbatim at write time, never
recomputed — live-proven, not just asserted, with the specific
adversarial case named in that spec's own Verification Results: a
`generate-readme` preview was shown, the source `package.json` was then
mutated a *second* time before approving, and the file actually written
still matched the *first* preview, not the post-mutation state. This
matters because Documentation's content genuinely depends on reading
real files at generation time (unlike DevOps's four write-capable MCP
tools, confirmed pure functions of their own parameters — no file reads,
no randomness), so a source file changing in the approval window is a
real, not hypothetical, risk this design closes structurally.

DevOps's `create_dockerfile`/`create_github_action`/
`create_dockercompose`/`create_gitignore` MCP tools each gained a
`dry_run` parameter (default `false`, preserving exact pre-040 behavior):
when true, computes and returns the real content without writing or
creating the output directory. Documentation's `generate-readme` and
`document-api`'s write path each split their existing content-computation
logic out from the write step, calling the read-only half once at preview
time and reusing its stored result at approval — `document-api`'s own
`skillDocumentApi()` already had nearly this shape internally (content
computed before the conditional write branch); this checkpoint's real
contribution there was wiring that existing shape to preview time, not
inventing a new one.

Rendering is a **dependency-free line diff** (Decision A — matches
`specs/031`'s own precedent of resolving "reuse an existing dependency or
add a lighter one" to neither) — the canonical implementation is
`packages/shared/line-diff.ts`'s `computeLineDiff()`/
`buildContentPreview()`, directly imported by the TUI (a real compiled
TypeScript file); the two browser dashboards render approval cards from
inline `<script>` template strings with no bundler linking them to that
module, the exact same constraint `specs/033`/`035` already hit for
`renderApprovalCard()`/`escapeHtml()` — solved the same way, porting the
algorithm verbatim rather than importing it. A diff renders when
overwriting; plain content renders on a fresh create; nothing renders
(byte-identical to before this spec) when neither field is present.
Oversized content (Decision B, over the existing `TASK_RESULT_MAX_BYTES`
64 KiB precedent, checked against the combined pair) **omits the
block entirely with an explicit note, never a truncated partial diff** —
resolved once it was clear the full content is already one click away
either way via the existing raw-JSON toggle/`GET /tasks/:id`, both
already uncapped regardless of what the formatted card shows; a card that
looks fully reviewable while silently withholding part of a large file
was judged strictly worse than one honest about what it isn't showing.

Live-verified against a real scratch target project (no LLM/provider key
needed — DevOps and Documentation's write skills are fully deterministic):
a real `dockerize` preview showing the exact interpolated Dockerfile
content, byte-identical to what got written after approval; a
`generate-readme` create case (no prior README) and a real overwrite case
producing a genuine `content`/`previousContent` diff pair, not
synthesized; and the drift-prevention adversarial case above. Both
dashboards' generated `/dashboard` HTML was confirmed in-process
(`app.fetch()`, no port bind — the same technique `specs/035` already
established) to contain the new rendering functions and CSS classes. Not
performed, recorded honestly rather than implied: a literal rendered-
pixel or rendered-terminal visual confirmation of the diff — what's
verified is that the underlying data is correct (live) and the rendering
functions producing markup/rows from that data are unit-tested and
present in the real generated output.

See specs/041-llm-harness-documentation/verification.md for the relocated narrative covering this checkpoint.

See specs/056-devops-preflight-and-idempotent-writes/verification.md for the relocated narrative covering this checkpoint.

See specs/079-phase-a-connect-orphaned-tools/verification.md for the relocated narrative covering this checkpoint.

See specs/081-testing-write-tests-skill/verification.md for the relocated narrative covering this checkpoint.

See specs/083-coder-agent/verification.md for the relocated narrative covering this checkpoint.

See specs/089-plan-step-skip-continue/verification.md for the relocated narrative covering this checkpoint.
