// specs/075-real-conversational-chat/spec.md §4 — live progress narration
// for a dispatched chat turn, driven by real STEP_STARTED/TOOL_CALL_START
// SSE events instead of one fixed "thinking…" string for the entire run.
//
// Deliberately a plain phrase-table lookup, not a further LLM call: a
// live ticker has to update the instant an event arrives, and skill ids
// are already a small, closed, human-legible set — a paraphrase would
// lag the real work, cost money per step, and risks finishing after the
// step it describes already has. One entry per skill already in
// SKILL_TIER_REGISTRY (apps/orchestrator/supervisor-graph.ts); an
// unlisted skill (a future addition this table hasn't caught up with)
// falls back to `"running ${skill}…"` — never silently blank.
const SKILL_PROGRESS_PHRASES: Record<string, string> = {
  "analyze-project": "analyzing your project…",
  "git-status": "checking git status…",
  "git-diff": "checking git diff…",
  "docker-status": "checking docker status…",
  "scan-secrets": "scanning for secrets…",
  "check-gitignore-coverage": "checking .gitignore coverage…",
  "audit-dependencies": "auditing dependencies…",
  dockerize: "writing a Dockerfile…",
  "create-ci": "writing a CI workflow…",
  "create-gitignore": "writing a .gitignore…",
  "create-compose": "writing a docker-compose file…",
  "generate-readme": "generating a README…",
  "document-api": "documenting the API…",
  "run-tests": "running tests…",
  "check-coverage": "checking test coverage…",
  "build-image": "building the docker image…",
  "verify-deployment": "verifying the deployment…",
  "commit-changes": "committing changes…",
  "run-command": "running a command…",
  "write-tests": "writing tests…",
  "review-diff": "reviewing the diff…",
  "edit-file": "editing the file…",
}

/** `stepName` arrives as `"${order}. ${skill}"` (apps/orchestrator/
 *  index.ts's STEP_STARTED emission) — this strips the leading ordinal
 *  so the phrase table can key on the bare skill id. */
export function skillFromStepName(stepName: string): string {
  return stepName.replace(/^\d+\.\s*/, "").trim()
}

export function progressPhraseForSkill(skill: string): string {
  return SKILL_PROGRESS_PHRASES[skill] ?? `running ${skill}…`
}

/** TOOL_CALL_START's own toolCallName is already a specific, human-legible
 *  tool/agent name (e.g. "git_status", "devops-agent") — narrated as-is,
 *  no lookup table needed for it. */
export function progressPhraseForTool(toolCallName: string): string {
  return `${toolCallName}…`
}
