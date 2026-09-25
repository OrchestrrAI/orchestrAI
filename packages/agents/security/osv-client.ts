// specs/084-security-external-vulnerability-data/spec.md — Phase F, the
// roadmap's own risk class 6: reaching a real external network service
// per task, for the first time in this codebase. Deliberately isolated
// from index.ts the same way llm-harness.ts already isolates the LLM
// enrichment logic. This client is used ONLY when
// ORCHESTRAI_SECURITY_EXTERNAL_DATA=1 (see model-factory.ts's
// isExternalDataFlagSet()) — with the flag unset, nothing in this file
// is ever called.
//
// OSV.dev (https://osv.dev) is a free, Google-run vulnerability
// database aggregating GitHub's own advisory database, npm audit
// advisories, and more. No API key or signup required; its own
// documentation states "no limits... currently" — still every call
// here is bounded by a real client-side timeout regardless, the same
// "bounded, never hang" precedent specs/045/049 already established
// elsewhere in this codebase, not assumed safe by the other side's own
// current policy alone.
//
// Real API shape, checked live against google.github.io/osv.dev before
// this was written, not assumed: POST /v1/querybatch returns only
// {vulns: [{id, modified}]} per query — ids only, no summary/severity.
// Full detail needs a follow-up GET /v1/vulns/{id} per id found.

const OSV_QUERYBATCH_URL = "https://api.osv.dev/v1/querybatch"
const OSV_VULN_URL = (id: string) => `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`

/** Real, bounded — a slow/hanging OSV response must degrade to the
 *  fail-open path in index.ts, never a hung task. */
export const OSV_TIMEOUT_MS = 8000

/** specs/084 §2 step 3 — a named constant, not a magic number: caps how
 *  many individual vulnerability-detail fetches happen per vulnerable
 *  package, so one pathologically-vulnerable dependency (real ones do
 *  exist with dozens of advisories) can't blow up the call count or the
 *  final result size. */
export const MAX_DETAIL_FETCHES_PER_PACKAGE = 3

export interface DependencyRef {
  name: string
  version: string
}

export interface VulnDetail {
  id: string
  summary?: string
  severity?: string
}

interface OsvQueryBatchResponse {
  results: { vulns?: { id: string; modified?: string }[] }[]
}

/** One real POST /v1/querybatch call for the whole dependency set.
 *  Returns a map of package name -> the real vuln ids OSV reports for
 *  it (an empty array when none are found — the caller distinguishes
 *  "checked, clean" from "never checked" itself). Throws a named error
 *  on any non-2xx response, network failure, or malformed body — never
 *  swallowed here; index.ts's own caller turns a thrown error into the
 *  fail-open "Vulnerability data unavailable: ..." note.
 *
 *  specs/085-multi-ecosystem-dependency-audit/spec.md — `ecosystem`
 *  defaults to "npm" so every specs/084 call site and test stays
 *  byte-identical; new callers pass OSV's own real ecosystem string
 *  ("PyPI"/"Go"/"Packagist"/"Maven"), checked live against OSV's schema
 *  docs before this spec was written, not guessed. */
export async function queryOsvBatch(
  packages: DependencyRef[],
  opts: { timeoutMs?: number; fetchFn?: typeof fetch; ecosystem?: string } = {},
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (packages.length === 0) return result

  const doFetch = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? OSV_TIMEOUT_MS
  const ecosystem = opts.ecosystem ?? "npm"

  const body = {
    queries: packages.map((p) => ({ package: { name: p.name, ecosystem }, version: p.version })),
  }

  let res: Response
  try {
    res = await doFetch(OSV_QUERYBATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new Error(`OSV.dev querybatch request failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    throw new Error(`OSV.dev querybatch returned HTTP ${res.status}`)
  }

  let parsed: OsvQueryBatchResponse
  try {
    parsed = (await res.json()) as OsvQueryBatchResponse
  } catch (err) {
    throw new Error(`OSV.dev querybatch response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!Array.isArray(parsed.results) || parsed.results.length !== packages.length) {
    throw new Error("OSV.dev querybatch response shape did not match the request (results length mismatch)")
  }

  packages.forEach((p, i) => {
    const vulns = parsed.results[i]?.vulns ?? []
    result.set(p.name, vulns.map((v) => v.id))
  })
  return result
}

/** One real GET /v1/vulns/{id} call per id — independently bounded, and
 *  independently failable: a single id's fetch failing does not fail
 *  the others (Promise.allSettled(), only fulfilled results included) —
 *  the same "partial success over all-or-nothing" instinct specs/060's
 *  own parallel-dispatch design already established elsewhere. */
export async function fetchVulnDetails(
  ids: string[],
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<VulnDetail[]> {
  if (ids.length === 0) return []

  const doFetch = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? OSV_TIMEOUT_MS

  const settled = await Promise.allSettled(
    ids.map(async (id): Promise<VulnDetail> => {
      const res = await doFetch(OSV_VULN_URL(id), { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`OSV.dev vuln detail for ${id} returned HTTP ${res.status}`)
      const body = (await res.json()) as { id?: string; summary?: string; severity?: unknown }
      const severity = Array.isArray(body.severity) && body.severity.length > 0
        ? String((body.severity[0] as { score?: unknown })?.score ?? "")
        : undefined
      return { id: body.id ?? id, summary: body.summary, severity: severity || undefined }
    }),
  )

  return settled
    .filter((r): r is PromiseFulfilledResult<VulnDetail> => r.status === "fulfilled")
    .map((r) => r.value)
}
