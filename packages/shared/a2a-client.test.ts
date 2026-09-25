import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { callAgent } from "./a2a-client"

afterEach(() => {
  mock.restore()
})

describe("shared A2A client", () => {
  test("submits a correlated task to the target agent and polls it directly", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined)
    const calls: { url: string; init?: RequestInit }[] = []
    let childId = ""
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        childId = body.id
        return Response.json({ id: childId, status: "submitted" })
      }
      return Response.json({ id: childId, status: "completed", result: "No exposed secrets detected." })
    }) as unknown as typeof fetch

    const result = await callAgent("security", 'scan for secrets at "C:\\projects\\demo"', {
      baseUrl: "http://127.0.0.1:3999",
      fetchImpl,
      timeoutMs: 200,
      pollIntervalMs: 0,
      callerName: "devops-agent",
      taskId: "parent-1",
    })

    expect(result).toBe("No exposed secrets detected.")
    expect(childId).toMatch(/^a2a-[0-9a-f-]{36}$/)
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:3999/",
      `http://127.0.0.1:3999/tasks/${encodeURIComponent(childId)}`,
    ])
    const submitted = JSON.parse(String(calls[0].init?.body))
    expect(submitted.id).toBe(childId)
    expect(submitted.message.role).toBe("agent")
    expect(submitted.message.parts[0].text).toContain("scan for secrets")
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  test("reports a failed target-agent task", async () => {
    spyOn(console, "log").mockImplementation(() => undefined)
    let childId = ""
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        childId = JSON.parse(String(init.body)).id
        return Response.json({ id: childId, status: "submitted" })
      }
      return Response.json({ id: childId, status: "failed", error: "scan failed" })
    }) as unknown as typeof fetch

    await expect(
      callAgent("security", "scan for secrets", {
        baseUrl: "http://127.0.0.1:3999",
        fetchImpl,
        timeoutMs: 200,
        pollIntervalMs: 0,
        callerName: "devops-agent",
        taskId: "parent-2",
      }),
    ).rejects.toThrow("scan failed")
  })

  test("resolves target base URL from the shared agent registry by default", async () => {
    spyOn(console, "log").mockImplementation(() => undefined)
    let requestedUrl = ""
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input)
      if (init?.method === "POST") return Response.json({ id: "x", status: "completed", result: "ok" })
      return Response.json({ id: "x", status: "completed", result: "ok" })
    }) as unknown as typeof fetch

    await callAgent("security", "scan for secrets", {
      fetchImpl,
      timeoutMs: 200,
      pollIntervalMs: 0,
      callerName: "devops-agent",
      taskId: "parent-3",
    })

    expect(requestedUrl.startsWith("http://localhost:3005")).toBe(true)
  })
})
