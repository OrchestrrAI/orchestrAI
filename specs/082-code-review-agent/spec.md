---
id: 082-code-review-agent
title: "Phase D: Code Review Agent — the First Genuinely New Agent"
area: code-review-agent
change_type: feature
status: implemented
verification: verified
created: 2026-09-12
updated: 2026-09-14
approved_by: Yusuf
approved_on: 2026-09-12
implemented_on: 2026-09-12
amends: []
related:
  - 078-capability-upgrade-roadmap
  - 079-phase-a-connect-orphaned-tools
  - 043-llm-harness-security
  - 039-per-component-llm-provider-config
  - 073-configurable-service-ports
  - 048-guided-init-experience
  - 030-authoritative-skill-dispatch-and-capability-catalog
  - 065-llm-only-skill-routing
  - 081-testing-write-tests-skill
supersedes: []
superseded_by: []
---

# Spec: Phase D: Code Review Agent — the First Genuinely New Agent

> Review gate: **APPROVED by Yusuf, 2026-09-12. Implemented and live-
> verified against a real Gemini deployment the same day** — a real
> planted bug caught, a real planted non-issue not invented, and the
> live LLM router naming `review-diff` with zero hardcoded routing
> change, dispatched all the way through the real Orchestrator. One
> item stays open, honestly marked (`verification: partial`, not
> `verified`): a real `docker compose up` pass, no Docker daemon
> available in the implementing session. See Acceptance Criteria and
> `verification.md` for the full transcript.
>
> `specs/078-capability-upgrade-roadmap/spec.md` names this Phase D
> verbatim: *"The first genuinely new agent, chosen because it writes
> nothing and so needs no approval gate at all — the cheapest way to
> prove new-agent integration end to end. Consumes Phase A's
> `git-diff`."* Its own `plan.md` adds the exact exit gate this spec's
> Acceptance Criteria are built around: *"a real review of a real diff
> in this repository, with a planted issue it must catch and a planted
> non-issue it must not invent; plus confirmation the router names its
> skill with no hardcoded routing changes."* Phase E (a write-capable
> Coder Agent) is explicitly gated on **both** Phase C (`specs/081`,
> already `verification: verified`) and this phase reaching the same
> status — nothing in Phase E is specced until then.
>
> Three design decisions were confirmed directly via AskUserQuestion
> before drafting: **(1)** the diff reviewed is **staged + unstaged
> combined** (the same shape DevOps's own `commit-changes` preview
> already uses), not unstaged-only. **(2)** ~~the harness works from
> diff hunks alone~~ **superseded, see below.** **(3)** a review comment
> may only cite an **added or context line** — a line genuinely present
> in the diff's post-image — never a removed line; "flag a risky
> deletion" is a real but separate capability, deferred.
>
> A self-review of this draft (Yusuf: *"any recomendation"*) surfaced
> four further refinements, three of which stood: **(a)** an ungrounded-
> comment failure now salvages the grounded remainder rather than
> discarding the whole review (§3) — **confirmed to stay** after a
> second, direct round of feedback ("Drop only the bad comment(s), keep
> the rest"). **(b)** the diff handed to the model is now explicitly
> size-bounded (§3). **(d)** the grounding parser's own edge cases
> (binary diffs, the "no newline" marker) are named explicitly (§3).
>
> **(c) was reversed on direct pushback ("why not [LangGraph]?").**
> Yusuf's own framing — *"I will need the agent to review all"* — meant
> the diff-hunks-only design (decision 2 above) was too narrow: a hunk
> in isolation can hide issues only visible with the surrounding file's
> real context. After laying out the concrete pros/cons directly (real
> context and fewer false positives/negatives vs. real token cost, a
> new deleted-file failure mode, and more test surface), Yusuf chose to
> add `read_project_file` back and use a real LangGraph tool-calling
> loop — the same shape DevOps's own harness (`specs/042`) already uses
> — rather than ship the narrower version now. §3 and §5 below reflect
> this final design; decision (2) and refinement (c) from the
> paragraphs above are superseded by it, kept here rather than deleted
> so the reasoning trail stays honest about the path taken to get here.

## Purpose

Every agent in this codebase today — DevOps, Testing, Documentation,
Security — already existed before this roadmap began; every capability
checkpoint so far has added a skill or a harness to one of them.
Phase D is deliberately different: it proves, at the lowest possible
risk, that a genuinely **new** agent process can be registered end to
end — discovered by the Orchestrator, named by the live LLM router with
zero hardcoded routing change, visible in both dashboards and the
guided-init flow — before Phase E bets a write-capable Coder Agent on
that same integration path actually working. Choosing a **read-only,
no-approval-gate** capability for this proof (reviewing an existing
diff) means a mistake in the new-agent wiring itself can never cause a
wrong write; the only risk being tested here is "does the plumbing
work," not "is this safe to approve."

## Verified Current State

Read 2026-09-12:

- Every current agent (DevOps :3002, Testing :3003, Documentation :3004,
  Security :3005) was already present before `specs/078`'s roadmap.
  Planning Agent existed once (port 3001) and was fully retired by
  `specs/051` — its port is explicitly never reused, confirmed by
  comments in both `apps/supervisor/index.ts` and `docker-compose.yml`.
  The next available port is **3007** (3006 is `mcp:http`).
- `packages/agents/security/index.ts` is this codebase's only existing
  precedent for a **read-only, no-approval-gate agent with no
  `resumeTask()` at all** — its own comment states plainly: *"All three
  skills are read-only — no NEEDS_APPROVAL set, no resumeTask. This
  agent never writes to disk, so no task ever reaches input-required."*
  It scans the target filesystem directly (`fs/promises`), not through
  MCP — a deliberate, separate decision (`specs/011`'s decision (c))
  this spec does not revisit.
- `specs/043-llm-harness-security/spec.md`'s harness
  (`packages/agents/security/llm-harness.ts`) is the precedent for a
  **structurally-enforced-safe LLM addition**: a Zod schema whose
  fields can only add commentary, never remove or downgrade a finding;
  `runEnrichment<T>()`'s bounded retry-with-feedback loop
  (`MAX_RETRIES = 2`) using `callProviderWithRetry`
  (`packages/shared/llm-model-factory.ts`, `specs/055`); a domain-
  specific guardrail (`containsForbiddenVulnerabilityClaim()`) enforced
  in the validator itself, not by prompt wording alone. **The one
  property this spec does NOT inherit from it**: Security's harness
  fails **open** (a failure just omits the AI commentary; the
  deterministic scan is always the task's real content). Code Review
  has no deterministic baseline to fall back to — reviewing a diff
  without an LLM produces nothing — so this spec's own harness must
  fail **closed**, the same precedent `specs/081`'s `write-tests`
  already established for exactly this reason ("no deterministic
  fallback exists for this skill").
- `packages/mcp/index.ts`'s `git_diff` tool (`specs/079`) takes
  `{repo_path?, staged?: boolean, file?}` and returns a raw unified diff
  or `"No changes found."`. `packages/agents/devops/index.ts`'s
  `computeFullUncommittedDiff()` (`specs/079`'s `commit-changes` skill)
  already fetches **both** `staged:true` and `staged:false` in parallel
  and concatenates them with `"=== Already staged ==="`/`"=== Not yet
  staged ==="` headers — the exact shape this spec's own diff-fetch
  reuses (an independent local copy, not an import — `computeFull
  UncommittedDiff()` is private to DevOps's module, and this codebase's
  own stated convention tolerates small local copies over cross-agent
  imports).
- Routing is **fully live, already generic** — confirmed by reading
  `apps/orchestrator/index.ts`: `KNOWN_AGENTS` is a flat array of
  registry URLs, and `findAgentForSkill()`/`buildCapabilitySnapshot()`
  iterate whatever `discoverAgent()` found live, with no per-agent
  branch anywhere in the routing path. Adding this agent's URL to
  `KNOWN_AGENTS` is the **entire** routing change required — this
  spec's own Acceptance Criteria treat that claim as testable, not
  assumed.
- The guided-init surfaces (`apps/supervisor/init-form.tsx`'s TUI form,
  `apps/supervisor/index.ts`'s classic wizard) both derive their
  selectable-agent lists from `AGENT_CATALOG`/`AGENTS` directly
  (`init-form.tsx:179`'s `const allAgents = AGENT_CATALOG.map((a) =>
  a.name)`; `apps/supervisor/index.ts:900`'s `const allServiceNames =
  AGENTS.map((a) => a.name)`) — confirmed by reading both call sites.
  There is no separate, independently-hardcoded UI list to find and
  update beyond the two structures already named in Proposed Behavior
  below.

## Proposed Behavior

### 1. A new agent: `code-review-agent`, port 3007

New files under `packages/agents/code-review/`:
`index.ts`/`model-factory.ts`/`llm-harness.ts`/`diff-grounding.ts` (+
`index.test.ts`/`diff-grounding.test.ts`). Structural template:
`packages/agents/security/index.ts` — Agent Card, `OWNED_SKILL_IDS`
derived from it, an in-memory task `Map`, `detectSkill()`, plain
`GET /.well-known/agent.json`/`GET /healthz`/`POST /`/`GET /tasks`/
`GET /tasks/:id`/`GET /tasks/:id/stream` routes, an inline dashboard,
`start()`/`PORT`/`import.meta.main`. **No `resumeTask()`, no pending-
actions map, no approve/reject routes at all** — copied by absence,
the same way Security's own file has none.

Unlike Security, this agent is a genuine **MCP client**
(`OrchestraiMcpClient`, constructed directly — the same shared class
Testing/Documentation already use with no per-agent wrapper subclass,
confirmed as the simpler, equally-valid pattern by reading
`packages/shared/mcp-client.ts`), since it needs `git_diff` and
(§5) `read_project_file`. `requiredTools: ["git_diff",
"read_project_file"]`.

Agent Card:
```ts
export const agentCard = {
  name: "code-review-agent",
  description: "Reviews a project's uncommitted git diff for real issues, grounded strictly in the actual changed lines",
  url: "http://localhost:3007",
  version: "1.0.0",
  skills: [{
    id: "review-diff",
    name: "Review Diff",
    description: "Review staged and unstaged changes in a project for correctness issues, grounded in real file:line citations from the diff",
    examples: ["review the diff at C:\\path\\to\\project", "review my changes", "code review this project"],
  }],
}
```

`detectSkill()` (used only when a task arrives with no `selectedSkill`
— e.g. a direct-to-agent submission bypassing the Orchestrator's own
live LLM router, `specs/065`):
```ts
function detectSkill(text: string): string {
  const lower = text.toLowerCase()
  if ((lower.includes("review") && (lower.includes("diff") || lower.includes("change") || lower.includes("code"))) || lower.includes("code review"))
    return "review-diff"
  return "unknown"
}
```
One skill only, so there is no ordering hazard to resolve against a
sibling skill the way `specs/079`/`080`/`081` each had to for their own
new skills within an already-multi-skill agent.

### 2. The `review-diff` flow

1. `resolveTargetPath(text)` (`packages/shared/index.ts`, unchanged,
   reused as-is) — an explicit absolute path in the task text, else
   `ORCHESTRAI_PROJECT_PATH`, else a named error. No guessing.
2. `existsSync(base)` — a named error if the path doesn't exist.
3. A local `computeFullUncommittedDiff()` (own copy of DevOps's
   function, using this agent's own `mcpClient`) — fetches **staged +
   unstaged combined** (the confirmed design choice; see §4).
4. **Empty diff** (`combinedDiff === ""`) → `completed` immediately
   with `"Nothing to review — no staged or unstaged changes."` — **no
   LLM call, independent of the harness flag entirely**. This is a
   distinct, harmless empty-input case, not "no deterministic
   fallback" (there is genuinely nothing to review).
5. `parseUnifiedDiff(combinedDiff)` (`diff-grounding.ts`, §3) — if
   parsing finds zero touched files despite a non-empty diff (should
   be unreachable, defensive only), fail closed rather than proceed
   with an empty grounding set.
6. `isHarnessFlagSet()` false → fail closed:
   `"review-diff requires ORCHESTRAI_CODE_REVIEW_LLM_HARNESS=1 — there
   is no deterministic fallback for this skill (a code review has no
   meaningful non-LLM answer)."`
7. `readLlmHarnessConfig()` null (flag on, no key) → fail closed with
   the named misconfiguration error, matching DevOps/Documentation/
   Testing's existing fail-closed-on-misconfiguration precedent (not
   Security's fail-open one — there is no baseline here to protect).
8. `runReviewDiffHarness()` (§3) → `null` (zero comments survived
   grounding after exhausted retries) → fail closed: `"the model's
   response could not be validated after retries (grounding check
   failed)."` A **partial** result (some comments grounded, some
   dropped) is not a failure — it proceeds to step 9 with an appended
   note naming how many were omitted.
9. Success → format into the task result:
   ```
   === Code Review ===
   Path: <base>
   Files reviewed: <n>

   [file.ts:42] <severity>
     <comment>

   Summary: <optional>
   ```

### 3. The grounding validator (`diff-grounding.ts` + `llm-harness.ts`)

`parseUnifiedDiff(diffText): ParsedDiff` — pure, no I/O. Splits on
`diff --git` boundaries; within each file's chunk, reads `+++ b/<path>`
for the canonical path (`+++ /dev/null` → a deleted file, excluded
entirely — no valid lines); finds every `@@ -a,b +c,d @@` hunk header
and walks the hunk body maintaining a running new-file line counter: a
`+` line or a context (` `) line is a **valid, citable** location and
increments the counter; a `-` line does not increment it and is never
valid (the confirmed §-out-of-scope decision above). Result:
`Map<normalizedPath, Set<lineNumber>>` (path normalized: strip a
leading `a/`/`b/`, `\`→`/`). A rename (`rename from`/`rename to`
headers, no content hunk) contributes no valid lines — a documented
scope cut, not a silent mishandling. **Two further edge cases named
explicitly, not left to be discovered mid-testing**: a binary-file
diff (`Binary files a/... and b/... differ` — no hunk, no valid lines,
not a parse error) and a `\ No newline at end of file` marker line
(must never be miscounted as a `+`/`-`/context content line).

`isGrounded(parsed, file, line): boolean` — a normalized lookup.

**Diff-size bound**: before either parsing or prompting, the combined
diff text is passed through `truncateUtf8()`
(`packages/shared/audit.ts`, the same primitive `boundTaskResult()`
already uses, reused directly rather than reinvented) at
`TASK_RESULT_MAX_BYTES` (64 KiB, that file's own existing constant).
**The same truncated text feeds both** `parseUnifiedDiff()` and the
prompt — never two different views of the diff — so the grounding
validator can never accept a citation from content the model never
actually saw. When truncation occurs, an explicit `"[diff truncated at
64 KiB]"` note is appended to the eventual task result, matching
`specs/040`'s own "never silently truncate" precedent for oversized
content.

`runReviewDiffHarness({ model, mcpClient, taskId, projectRoot, diffText, parsed, maxRetries? })`
(`llm-harness.ts`) — a real **LangGraph tool-calling loop**, the same
shape DevOps's own harness (`specs/042`) already uses, not Security's
plain retry-only core: `buildReadOnlyTools()` binds exactly one tool,
`read_project_file` (the identical shape to DevOps's own — see the
exact code quoted in §5), structurally allow-listed the same way
(`READ_ONLY_TOOL_NAMES = ["read_project_file"]`, a build-time throw if
anything else is ever bound). The model may call it as many or as few
times as it judges useful (e.g. to read a touched file's full content
for real context beyond the diff hunk) before producing its final
structured response; the tool-call loop and the response-validation
retry loop (below) are two independent bounded mechanisms, exactly as
they already are in every LangGraph-based harness in this codebase.
`MAX_RETRIES = 2` for the validation loop, `callProviderWithRetry` for
transient-provider-error retries — both unchanged from Security's
core. Schema:
```ts
export const ReviewCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(["blocking", "suggestion", "nit"]),
  comment: z.string().min(1),
})
export const ReviewDiffResultSchema = z.object({
  comments: z.array(ReviewCommentSchema),
  summary: z.string().optional(),
})
```
System prompt: states plainly the model may comment **only** on
locations shown in the (possibly truncated) diff below, must cite the
exact real file path and new-file line number as they appear there,
must never invent a file or line absent from it, and must never claim
to know the code's actual runtime behavior beyond what the diff itself
shows.

**The validator and its failure handling — revised after self-review**:
the direct equivalent of Security's `containsForbiddenVulnerabilityClaim()`
guard, checking every returned comment via `isGrounded()`. The first
draft of this spec discarded the *entire* response the moment any
comment failed grounding after exhausted retries — self-review flagged
this as throwing away real, correct findings alongside one bad one,
inconsistent with Security's own CVE-guard precedent, which drops only
the offending claim and keeps the rest. Revised design: retry the whole
response with feedback first, unchanged, up to `MAX_RETRIES` (naming
the real valid `file:line` locations in the retry prompt, capped list,
to bound prompt size); on final exhaustion, **filter to only the
grounded comments and return those**, with an explicit `"N comment(s)
omitted for citing a location not present in the diff"` note appended
to the result. The task fails closed (`null`) only when **zero**
comments survive grounding after the final attempt — genuinely nothing
trustworthy to report, the same bar `specs/081`'s `write-tests` already
applies to its own exhausted-retries case.

### 4. Diff scope: staged + unstaged, combined

Matches DevOps's own `commit-changes` preview shape exactly (§Verified
Current State) — reviewing "everything not yet committed" is the more
literal reading of "review my changes" for an agent that never commits
anything itself, and avoids missing something already staged for the
next commit.

### 5. Full-file context via `read_project_file` (LangGraph tool loop)

Confirmed final design, reversing this spec's own earlier "diff hunks
only" draft (see the review-gate note above for the reasoning trail).
`buildReadOnlyTools(mcpClient, taskId, projectRoot)` binds exactly one
tool, matching DevOps's own `llm-harness.ts` shape token-for-token:
```ts
export const READ_ONLY_TOOL_NAMES = ["read_project_file"] as const

export function buildReadOnlyTools(mcpClient: McpToolCaller, taskId: string, projectRoot: string) {
  const readProjectFile = tool(
    async ({ relative_path }: { relative_path: string }) => {
      return mcpClient.callTool("read_project_file", { project_root: projectRoot, relative_path }, taskId)
    },
    {
      name: "read_project_file",
      description: "Read a file's content within the target project. relative_path is relative to the project root — never an absolute path.",
      schema: z.object({ relative_path: z.string() }),
    },
  )
  const tools = [readProjectFile]
  for (const t of tools) {
    if (!(READ_ONLY_TOOL_NAMES as readonly string[]).includes(t.name)) {
      throw new Error(`Refusing to bind non-allow-listed tool "${t.name}" to the LLM harness`)
    }
  }
  return tools
}
```
The system prompt tells the model it may call `read_project_file` for
any file touched by the diff (or a related file) to get real context
beyond the isolated hunk, before producing its final review.

**The new failure mode this introduces — a touched file deleted since
the diff was taken — needs no new code.** `read_project_file`
(`packages/mcp/index.ts`) already returns a plain text error
(`"Path not found: <path>"`) rather than throwing for a missing file;
LangGraph's `ToolNode` already forwards that text back to the model as
the tool call's own result, exactly like every other tool-call error
in every existing LangGraph-based harness in this codebase. The model
simply sees the error and can proceed without that file's content —
this is the same mechanism, not a new one, and is named here so it's
tested deliberately rather than discovered by accident.

No new byte-size bound is introduced for a single fetched file's
content, beyond the diff's own truncation (§3) — matching every
existing LangGraph harness in this codebase (DevOps's, Documentation's),
none of which caps an individual `read_project_file` call's own result
size either. This is stated as a known, shared limitation, not a new
one this spec introduces.

## Scope

In scope: the `code-review-agent` process end to end (Agent Card, the
one `review-diff` skill, the diff-fetch/parse/harness/format flow, the
grounding validator with its own unit tests); every registration point
a new agent requires (see below); `CLAUDE.md` updates describing the
new agent, matching every prior new-capability checkpoint's own
documentation discipline.

Registration points, each a concrete, small edit:

1. `packages/shared/service-ports.ts` — `SERVICE_PORT_ENV_VARS.codeReview
   = "ORCHESTRAI_CODE_REVIEW_PORT"`, `DEFAULT_SERVICE_PORTS.codeReview =
   3007`.
2. `packages/shared/agent-registry.ts` — a `codeReview` entry in the
   `agents` const, resolved via `resolveServicePort("codeReview")`.
3. `apps/orchestrator/index.ts` — add `agentRegistry.codeReview` to
   `KNOWN_AGENTS`. Confirmed to be the **entire** routing change needed
   (§Verified Current State).
4. `apps/supervisor/index.ts` — `SERVICE_STARTERS` (dynamic import) and
   `AGENTS: ServiceDef[]` (`dependsOnMcp: true`, since this agent is a
   genuine MCP client, unlike Security's own entry).
5. `apps/supervisor/agent-catalog.ts` — `{ name: "code-review-agent",
   skillIds: ["review-diff"] }`; `agent-catalog.test.ts`'s exhaustive
   agent-name list and a new matching drift-check test block (the same
   pattern its four existing per-agent tests already use).
6. `apps/orchestrator/supervisor-graph.ts` — `"review-diff":
   "read-only"` in `SKILL_TIER_REGISTRY`, and `"review-diff"` in
   `SUPERVISOR_ALLOWED_SKILLS` (two independently-maintained structures
   by this file's own stated design, checked by its own drift tests).
7. Root `package.json` — a `"code-review-agent"` script mirroring
   `"security-agent"`'s exactly; inserted into the `dev`/
   `dev:with-mcp`/`dev:with-all-mcp` `--parallel` strings (after
   `security-agent`, before `orchestrator`).
8. `docker-compose.yml` — a new service block shaped exactly like
   `devops-agent`'s (MCP client, no target-volume mount, `ORCHESTRAI_
   MCP_URL`/`ORCHESTRAI_MCP_ALLOWED_HOSTS` env, `depends_on: mcp-http:
   condition: service_healthy`, port `3007:3007`); `orchestrator`'s own
   block gains `ORCHESTRAI_CODE_REVIEW_URL` and a matching
   `depends_on` entry.
9. `packages/shared/llm-model-factory.ts` — `"codeReview"` added to the
   `LLM_COMPONENTS` as-const array (`specs/039`'s per-component
   pattern).
10. `apps/supervisor/init-wizard.ts` — a `codeReview` row in
    `AGENT_LLM_HARNESSES` (`{agent: "code-review-agent", component:
    "codeReview", field: "codeReviewLlm", envVar:
    "ORCHESTRAI_CODE_REVIEW_LLM_HARNESS", label: "Code Review LLM"}`) —
    confirmed generic enough to need no separate UI-list edit
    (§Verified Current State).
11. `CLAUDE.md` — architecture diagram, "Current services and skills"
    table, dashboard URL list, and the "N agents are MCP clients now"
    paragraph update.
12. **Found during implementation, not anticipated at spec-drafting
    time**: `apps/supervisor/init-form.tsx`'s own `PORT_ROW_LABELS`
    (`specs/073`'s guided-init Ports section) is a `Record<ServicePortName,
    string>` — TypeScript's own exhaustiveness check caught the missing
    `codeReview` entry immediately at `bun run typecheck`, closing what
    would otherwise have been a silent 7th registration point.

Out of scope: removed-line citations (§ decision 3), any change to
DevOps/Testing/Documentation/Security's own skills or harnesses, and
Phase E (Coder Agent) itself — not specced further until this phase
and `specs/081` are both `verification: verified`, per the roadmap's
own stated gating.

## Safety and Compatibility Constraints

- **No approval gate anywhere, structurally, not by omission-and-hope**:
  no `resumeTask()`, no pending-actions map, no approve/reject routes
  exist in this agent's code at all — the same absence Security's own
  file already demonstrates is sufficient and safe for a genuinely
  read-only, no-write agent.
- The grounding validator is a **structural** check (a real lookup
  against parsed diff data), not a prompt instruction alone — the same
  enforcement style `containsForbiddenVulnerabilityClaim()` and
  `READ_ONLY_TOOL_NAMES`'s build-time throws already establish
  elsewhere in this codebase.
- Fail-closed on every precondition gap (no target path, no detected
  diff-parse result, harness off, harness misconfigured, exhausted
  grounding retries) — this is a deliberate departure from Security's
  own fail-open harness precedent, justified explicitly in §Verified
  Current State (no deterministic baseline exists here to protect).
- This agent never writes to any file, calls no write-capable MCP
  tool, and has no code path that could ever reach one.

## Out of Scope / Non-Goals

- Reviewing a specific named file outside a diff context (a materially
  different feature, not this phase's own exit-gate scenario).
- Removed-line citations ("you deleted an important check").
- Any write capability, approval flow, or execution capability for
  this agent, ever, under this spec.
- Phase E (Coder Agent) — explicitly deferred until this phase and
  `specs/081` both reach `verification: verified`.

## Acceptance Criteria

- [x] `review-diff` is detected from natural task text and via an
      explicit `selectedSkill` — confirmed via real HTTP requests
      against the real, unmodified app (`packages/agents/code-review/
      index.test.ts`).
- [x] No target path / a nonexistent path fails closed with a named
      error.
- [x] An empty diff (no staged or unstaged changes) completes with
      "nothing to review," making **no LLM call**, independent of the
      harness flag's state — implemented as a short-circuit before the
      harness-flag check is ever reached.
- [x] Harness off + a real diff present → fails closed with the exact
      "no deterministic fallback" error.
- [x] Harness on, misconfigured (no key) → fails closed with a
      distinct, named configuration error.
- [x] Grounding-parser unit tests: a real multi-file diff, added/
      context/removed line classification, a deleted file (empty valid-
      lines set), a renamed file (no valid lines, documented), path
      normalization (`a/`/`b/` stripping, backslash normalization), a
      binary-file diff (no crash, no valid lines), and a `\ No newline
      at end of file` marker line (not miscounted as content) — 12
      tests, `diff-grounding.test.ts`.
- [x] A forced ungrounded response from an injected fake model is
      rejected and retried; a response mixing grounded and ungrounded
      comments, after exhausted retries, salvages only the grounded
      ones with an explicit "N omitted" note; a response where **every**
      comment is ungrounded, after exhausted retries, fails the task
      closed — all confirmed via `llm-harness.test.ts` (10 tests, a
      `ScriptedChatModel`/`MockMcpToolCaller` pairing, no live model).
      A real, non-obvious bug was found and fixed while writing these
      tests: reusing the identical `AIMessage` object across scripted
      retry responses caused LangGraph's own message reducer (which
      dedupes by object identity/id) to silently replace an earlier
      turn instead of appending a new one, corrupting which message
      the harness read as "the model's latest response" on retry 2+.
      Fixed by constructing a fresh message object per attempt in the
      test — a real lesson about this pattern, not a harness bug.
- [x] A diff exceeding `TASK_RESULT_MAX_BYTES` is truncated identically
      before both parsing and prompting, with an explicit truncation
      note in the eventual result.
- [x] The harness's `read_project_file` tool binding is structurally
      allow-listed (a build-time throw if anything else is ever bound,
      mirroring `buildReadOnlyTools()`'s existing enforcement elsewhere)
      and no write-capable tool is ever reachable from the graph.
- [x] A `read_project_file` call for a file that no longer exists (a
      touched file deleted since the diff was taken) surfaces the real
      MCP error text back to the model as the tool result and does not
      crash the harness or fail the task — confirmed via a fake model/
      fake MCP client pairing that deliberately requests a missing file.
- [x] **Planted issue caught, live**: **live-verified 2026-09-12**
      against a real Gemini deployment (`gemini-3.5-flash`) — a real
      git repo with `clamp()`'s comparison branches deliberately
      swapped (`if (value < min) return max`, a genuine bug) produced
      a `blocking` comment citing the exact real location `math.ts:2`,
      correctly describing the real defect.
- [x] **Planted non-issue not invented, live**: the same diff also
      added a genuinely correct new `sum()` function alongside the
      real bug — the review's only comment was the real bug; the
      correct addition was never flagged, and no comment cited any
      location absent from the diff.
- [x] **The router names the skill with zero hardcoded routing
      change**: **live-verified** — with the real Orchestrator running
      a real Gemini-backed router (`ORCHESTRAI_LLM_API_KEY` set,
      every other agent pointed at an unreachable stub port to isolate
      this one), a natural-language `POST /tasks {"text": "review my
      changes at ..."}` request with no `selectedSkill` resolved to
      `{"assignedAgent":"code-review-agent","skill":"review-diff"}`
      purely from the live capability snapshot, and the dispatched
      task completed end to end with the same real review result.
- [x] Dashboard, `/healthz`, `/.well-known/agent.json`, `/tasks`,
      `/tasks/:id`, `/tasks/:id/stream` all present and correct,
      matching Security's own shape; no approve/reject route exists —
      confirmed the route 404s (`index.test.ts`) and live via a real
      `/healthz` call during the verification pass.
- [x] `AGENT_CATALOG`'s drift test passes with the new entry matching
      the real `agentCard.skills` exactly; `SKILL_TIER_REGISTRY`/
      `SUPERVISOR_ALLOWED_SKILLS` drift tests pass with `review-diff`
      present in both.
- [x] `bun test`, `bun run typecheck`, `bun run specs:check` pass; the
      full pre-existing suite is unaffected — 980 pass, 0 fail (net
      +18 over `specs/081`'s own 949 — closer to +31 counting the
      6 pre-existing tests updated for the new agent joining shared
      tables), typecheck clean, `specs:check` passed for 81 specs.
- [x] `docker-compose.yml`'s new block is shape-reviewed (mirrors
      `devops-agent`'s exact shape, confirmed by reading the file
      before writing it). **Attempted live 2026-09-14, substantial
      progress, not yet completed**: a real `docker compose build`+`up`
      pass found and fixed 3 genuine, previously-latent bugs (a
      Dockerfile bug dropping `@modelcontextprotocol/sdk` from the
      image; `testing-agent`/`documentation-agent` missing
      `ORCHESTRAI_MCP_URL` in compose; `code-review-agent`'s own bad
      local `existsSync()` precondition check) and confirmed the
      routing/discovery wiring this item cares about (all 5 agents
      online, `review-diff` correctly named from the live capability
      snapshot). A 4th bug (the base image missing `git`/`curl`) was
      found but not yet confirmed fixed live — the host ran out of
      disk space mid-rebuild, crashing Docker Desktop's own engine;
      not yet restarted in this session. See `verification.md`'s
      "Docker Desktop live pass, 2026-09-14" section for the full
      record. `verification` stays `partial`.

## Verification Plan

- Unit + HTTP-level, no live provider needed: skill detection, the
  three fail-closed preconditions, the empty-diff short-circuit's
  independence from the harness flag, the grounding parser's own pure
  unit tests, and the forced-ungrounded-response retry/exhaustion path
  via an injected fake model.
- Live, with a real provider key (the same Gemini deployment already
  used for `specs/080`/`081`'s own live passes): a real planted issue
  caught, a real planted non-issue not invented, and the router-naming
  confirmation with zero hardcoded routing change.

## Approval Requested

Approve to proceed with Phase D as scoped above — the first genuinely
new agent this codebase adds, deliberately the lowest-risk possible
proof of the new-agent integration path before Phase E (Coder Agent)
is ever specced.
