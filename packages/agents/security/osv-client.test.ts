// specs/084-security-external-vulnerability-data/spec.md — mocked fetch
// throughout, matching apps/supervisor/model-discovery.test.ts's own
// existing convention for network-adjacent code in this codebase. No
// real network call, no real credential (OSV needs none anyway).
import { describe, expect, test } from "bun:test"
import { fetchVulnDetails, MAX_DETAIL_FETCHES_PER_PACKAGE, queryOsvBatch } from "./osv-client"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("queryOsvBatch", () => {
  test("returns real hit ids per package, mapped by name", async () => {
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.osv.dev/v1/querybatch")
      const body = JSON.parse(String(init?.body))
      expect(body.queries).toEqual([
        { package: { name: "left-pad", ecosystem: "npm" }, version: "1.0.0" },
        { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.21" },
      ])
      return jsonResponse(200, {
        results: [
          { vulns: [{ id: "GHSA-xxxx-xxxx-xxxx", modified: "2023-01-01T00:00:00Z" }] },
          { vulns: [] },
        ],
      })
    }) as unknown as typeof fetch

    const result = await queryOsvBatch(
      [{ name: "left-pad", version: "1.0.0" }, { name: "lodash", version: "4.17.21" }],
      { fetchFn },
    )
    expect(result.get("left-pad")).toEqual(["GHSA-xxxx-xxxx-xxxx"])
    expect(result.get("lodash")).toEqual([])
  })

  test("an empty package list makes no network call at all", async () => {
    const fetchFn = (async () => { throw new Error("should never be called") }) as unknown as typeof fetch
    const result = await queryOsvBatch([], { fetchFn })
    expect(result.size).toBe(0)
  })

  test("a non-2xx response throws a named error", async () => {
    const fetchFn = (async () => jsonResponse(500, { error: "internal" })) as unknown as typeof fetch
    await expect(queryOsvBatch([{ name: "x", version: "1.0.0" }], { fetchFn })).rejects.toThrow(/HTTP 500/)
  })

  test("a network failure throws a named error", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch
    await expect(queryOsvBatch([{ name: "x", version: "1.0.0" }], { fetchFn })).rejects.toThrow(/OSV.dev querybatch request failed/)
  })

  test("malformed JSON throws a named error", async () => {
    const fetchFn = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch
    await expect(queryOsvBatch([{ name: "x", version: "1.0.0" }], { fetchFn })).rejects.toThrow(/not valid JSON/)
  })

  test("a results-length mismatch throws a named error", async () => {
    const fetchFn = (async () => jsonResponse(200, { results: [] })) as unknown as typeof fetch
    await expect(queryOsvBatch([{ name: "x", version: "1.0.0" }], { fetchFn })).rejects.toThrow(/shape did not match/)
  })

  test("a real, bounded AbortSignal is passed on every call — the timeout mechanism itself is a native runtime primitive, not reinvented here", async () => {
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return jsonResponse(200, { results: [{ vulns: [] }] })
    }) as unknown as typeof fetch

    await queryOsvBatch([{ name: "x", version: "1.0.0" }], { fetchFn, timeoutMs: 50 })
  })
})

describe("fetchVulnDetails", () => {
  test("returns real detail per id", async () => {
    const fetchFn = (async (url: string | URL) => {
      expect(String(url)).toBe("https://api.osv.dev/v1/vulns/GHSA-xxxx-xxxx-xxxx")
      return jsonResponse(200, { id: "GHSA-xxxx-xxxx-xxxx", summary: "A real summary" })
    }) as unknown as typeof fetch

    const result = await fetchVulnDetails(["GHSA-xxxx-xxxx-xxxx"], { fetchFn })
    expect(result).toEqual([{ id: "GHSA-xxxx-xxxx-xxxx", summary: "A real summary", severity: undefined }])
  })

  test("an empty id list makes no network call at all", async () => {
    const fetchFn = (async () => { throw new Error("should never be called") }) as unknown as typeof fetch
    expect(await fetchVulnDetails([], { fetchFn })).toEqual([])
  })

  test("one id failing does not fail the others — partial success", async () => {
    const fetchFn = (async (url: string | URL) => {
      if (String(url).endsWith("BAD-ID")) return jsonResponse(500, { error: "gone" })
      return jsonResponse(200, { id: "GOOD-ID", summary: "fine" })
    }) as unknown as typeof fetch

    const result = await fetchVulnDetails(["GOOD-ID", "BAD-ID"], { fetchFn })
    expect(result).toEqual([{ id: "GOOD-ID", summary: "fine", severity: undefined }])
  })

  test(`the caller, not this function, is responsible for the ${MAX_DETAIL_FETCHES_PER_PACKAGE}-per-package cap`, async () => {
    let callCount = 0
    const fetchFn = (async (url: string | URL) => {
      callCount++
      return jsonResponse(200, { id: String(url).split("/").pop() })
    }) as unknown as typeof fetch

    await fetchVulnDetails(["a", "b", "c", "d", "e"], { fetchFn })
    expect(callCount).toBe(5) // fetchVulnDetails itself fetches everything it's given
  })
})
