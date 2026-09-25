// specs/137-plan-step-acts-only-on-its-own-step/spec.md
//
// A plan step's child task text carries the step itself AND the user's
// whole request, so agents can still find the project path or a stated
// value the step description left out. Before this spec the two were
// joined by " — ", and Coder used the whole string as its instruction: in
// a mixed plan, the edit-files step also did the .gitignore step's work.
//
// The marker below separates them unambiguously (an em dash can occur in
// either part). Every agent whose model reads the request splits on it:
// the model is instructed with the step only and shown the request as
// capped, labelled background. Deterministic readers (resolveTargetPath,
// extractPort) keep reading the whole text, marker included.

export const PLAN_CONTEXT_MARKER =
  "\n\n[orchestrai:plan-context] The user's full request, for background only — act only on the step above:\n"

/** Same cap as specs/134's request text. */
export const MAX_PLAN_BACKGROUND_CHARS = 2000

export interface PlanStepText {
  /** The step itself: everything before the first marker (or the whole
   *  text when there is none). */
  step: string
  /** The user's full request, or null for a direct (non-plan) task. */
  context: string | null
}

export function buildPlanStepText(skill: string, description: string, parentText: string): string {
  return `${skill}: ${description}${PLAN_CONTEXT_MARKER}${parentText}`
}

export function splitPlanStepText(text: string): PlanStepText {
  const at = text.indexOf(PLAN_CONTEXT_MARKER)
  if (at < 0) return { step: text, context: null }
  const context = text.slice(at + PLAN_CONTEXT_MARKER.length).trim()
  return { step: text.slice(0, at).trim(), context: context.length > 0 ? context : null }
}

/** The one wording every split-aware harness uses for the background
 *  block, capped. Empty string when there is no context. */
export function renderPlanBackground(context: string | null | undefined): string {
  const trimmed = context?.trim()
  if (!trimmed) return ""
  const bounded = trimmed.length > MAX_PLAN_BACKGROUND_CHARS
    ? trimmed.slice(0, MAX_PLAN_BACKGROUND_CHARS) + "… [truncated]"
    : trimmed
  return [
    "Background — the user's full request, of which your task is ONE step:",
    "<<<BACKGROUND",
    bounded,
    "BACKGROUND>>>",
    "Background only: do only the step you were given. Change nothing, and create nothing, that the step itself does not ask for — other parts of the request belong to other steps.",
  ].join("\n")
}
