export const MAX_PLAN_STEPS_PER_RUN = 50

export interface PlanStepRow {
  key: string
  name: string
  outcome: "running" | "completed" | "failed"
  timestamp: number
}

export type PlanStepsByRun = Record<string, Record<string, PlanStepRow>>

interface StepEventLike {
  type?: unknown
  runId?: unknown
  stepName?: unknown
  outcome?: unknown
  timestamp?: unknown
}

/** Applies the STEP_* subset while bounding retained rows for every run. */
export function reducePlanStepEvent(
  current: PlanStepsByRun,
  input: StepEventLike,
  maxPerRun = MAX_PLAN_STEPS_PER_RUN,
): PlanStepsByRun {
  if (input.type !== "STEP_STARTED" && input.type !== "STEP_FINISHED") return current
  if (typeof input.runId !== "string" || input.runId.trim() === "") return current
  if (typeof input.stepName !== "string" || input.stepName.trim() === "") return current
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) return current

  const outcome = input.type === "STEP_STARTED"
    ? "running"
    : input.outcome === "completed" ? "completed" : "failed"
  const key = input.stepName.trim()
  const timestamp = typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
    ? input.timestamp
    : Date.now()
  const forRun = { ...(current[input.runId] ?? {}) }

  delete forRun[key]
  forRun[key] = { key, name: input.stepName.trim(), outcome, timestamp }

  const keys = Object.keys(forRun)
  for (const oldest of keys.slice(0, Math.max(0, keys.length - maxPerRun))) {
    delete forRun[oldest]
  }

  return { ...current, [input.runId]: forRun }
}
