// specs/084-security-external-vulnerability-data/spec.md — HTTP-level
// tests against the real, unmodified app for audit-dependencies' new
// vulnerability section. No live OSV.dev call — global fetch is mocked
// for the duration of each flag-on test and restored afterward, the
// same technique noted in this spec's own plan.md.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { randomUUID } from "node:crypto"
import * as path from "path"
import { app } from "./index"

let projectDir: string

beforeAll(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "security-audit-deps-"))
  writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({
      name: "scratch",
      dependencies: { "left-pad": "1.0.0", lodash: "^4.17.21" },
      devDependencies: { "some-tool": "*" },
    }),
  )
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.ORCHESTRAI_SECURITY_EXTERNAL_DATA
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

async function submit(text: string) {
  const id = `t-${randomUUID()}`
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, message: { role: "user", parts: [{ text }] }, selectedSkill: "audit-dependencies" }),
  })
  expect(res.status).toBe(200)
  return id
}

async function getTaskAfter(id: string, statuses: string[], maxMs = 3000): Promise<any> {
  const start = Date.now()
  let last: any
  while (Date.now() - start < maxMs) {
    const r = await app.request(`/tasks/${id}`)
    last = await r.json()
    if (statuses.includes(last.status)) return last
    await Bun.sleep(10)
  }
  return last
}

describe("specs/084 — audit-dependencies, ORCHESTRAI_SECURITY_EXTERNAL_DATA unset (default)", () => {
  test("output is byte-identical to the pre-084 shape — no vulnerability section at all", async () => {
    const id = await submit(`audit dependencies at ${projectDir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).not.toContain("Known Vulnerabilities")
    expect(task.result).toContain("=== Dependency Audit ===")
    expect(task.result).toContain('some-tool: "*"')
  })
})

describe("specs/084 — audit-dependencies, flag set", () => {
  test("a real hit is reported with real data from the (mocked) OSV response", async () => {
    process.env.ORCHESTRAI_SECURITY_EXTERNAL_DATA = "1"
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("querybatch")) {
        return jsonResponse(200, {
          results: [
            { vulns: [{ id: "GHSA-xxxx-xxxx-xxxx" }] }, // left-pad
            { vulns: [] }, // lodash
          ],
        })
      }
      return jsonResponse(200, { id: "GHSA-xxxx-xxxx-xxxx", summary: "A real vulnerability summary" })
    }) as unknown as typeof fetch

    const id = await submit(`audit dependencies at ${projectDir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Known Vulnerabilities (OSV.dev) ===")
    expect(task.result).toContain("left-pad@1.0.0: GHSA-xxxx-xxxx-xxxx — A real vulnerability summary")
    expect(task.result).not.toContain("lodash@4.17.21: GHSA")
  })

  test("a clean lookup (zero hits) reports 'No known vulnerabilities found.' explicitly, not silence", async () => {
    process.env.ORCHESTRAI_SECURITY_EXTERNAL_DATA = "1"
    globalThis.fetch = (async () => jsonResponse(200, { results: [{ vulns: [] }, { vulns: [] }] })) as unknown as typeof fetch

    const id = await submit(`audit dependencies at ${projectDir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Known Vulnerabilities (OSV.dev) ===\nNo known vulnerabilities found.")
  })

  test("a lookup failure fails open — the rest of the report is fully intact, task still completes", async () => {
    process.env.ORCHESTRAI_SECURITY_EXTERNAL_DATA = "1"
    globalThis.fetch = (async () => { throw new Error("simulated network failure") }) as unknown as typeof fetch

    const id = await submit(`audit dependencies at ${projectDir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit ===")
    expect(task.result).toContain('some-tool: "*"')
    expect(task.result).toContain("Vulnerability data unavailable:")
    expect(task.result).toContain("simulated network failure")
  })

  test("a non-2xx response also fails open with a named reason", async () => {
    process.env.ORCHESTRAI_SECURITY_EXTERNAL_DATA = "1"
    globalThis.fetch = (async () => jsonResponse(503, { error: "unavailable" })) as unknown as typeof fetch

    const id = await submit(`audit dependencies at ${projectDir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("Vulnerability data unavailable:")
    expect(task.result).toContain("HTTP 503")
  })
})

// ============================================================
// specs/085-multi-ecosystem-dependency-audit/spec.md
// ============================================================
describe("specs/085 — no manifest of any kind fails closed", () => {
  test("names all five files checked", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-no-manifest-"))
    const id = await submit(`audit dependencies at ${dir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("failed")
    expect(task.error).toContain("package.json")
    expect(task.error).toContain("requirements.txt")
    expect(task.error).toContain("go.mod")
    expect(task.error).toContain("composer.json")
    expect(task.error).toContain("pom.xml")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("specs/085 — Python (requirements.txt)", () => {
  test("real content correctly audited, header labeled (PyPI)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-python-"))
    writeFileSync(path.join(dir, "requirements.txt"), "requests==2.31.0\nflask>=2.0\n")
    const id = await submit(`audit dependencies at ${dir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit (PyPI) ===")
    expect(task.result).toContain("Total dependencies: 2")
    expect(task.result).toContain('flask: ">=2.0"')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("specs/085 — Go (go.mod)", () => {
  test("real content correctly audited, no spurious unpinned claims, header labeled (Go)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-go-"))
    writeFileSync(
      path.join(dir, "go.mod"),
      "module example.com/scratch\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n",
    )
    const id = await submit(`audit dependencies at ${dir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit (Go) ===")
    expect(task.result).toContain("Total dependencies: 1")
    expect(task.result).not.toContain("Unpinned")
    expect(task.result).not.toContain("All dependencies are pinned")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("specs/085 — Packagist (composer.json)", () => {
  test("real content correctly audited, platform packages excluded, header labeled (Packagist)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-composer-"))
    writeFileSync(
      path.join(dir, "composer.json"),
      JSON.stringify({ require: { php: ">=7.4", "monolog/monolog": "2.9.1", "guzzlehttp/guzzle": "^7.0" } }),
    )
    const id = await submit(`audit dependencies at ${dir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit (Packagist) ===")
    expect(task.result).toContain("Total dependencies: 2") // php excluded
    expect(task.result).toContain('guzzlehttp/guzzle: "^7.0"')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("specs/085 — Maven (pom.xml)", () => {
  test("real content correctly audited, no spurious unpinned claims, header labeled (Maven)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-maven-"))
    writeFileSync(
      path.join(dir, "pom.xml"),
      "<project><dependencies><dependency><groupId>org.example</groupId><artifactId>lib</artifactId><version>1.0.0</version></dependency></dependencies></project>",
    )
    const id = await submit(`audit dependencies at ${dir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit (Maven) ===")
    expect(task.result).toContain("Total dependencies: 1")
    expect(task.result).not.toContain("Unpinned")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("specs/085 — npm lockfile widening (vuln section only, unpinned-check untouched)", () => {
  test("with NO lockfile: top header and unpinned-check are byte-identical to the pre-085 shape", async () => {
    const id = await submit(`audit dependencies at ${projectDir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit ===") // still exactly unlabeled
    expect(task.result).toContain('some-tool: "*"')
  })

  test("WITH a real lockfile: vulnerability section surfaces a real transitive dependency the manifest alone would miss; unpinned-check section is unaffected", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-npm-lock-"))
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "scratch", dependencies: { "left-pad": "1.0.0" } }),
    )
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "scratch" },
          "node_modules/left-pad": { version: "1.0.0" },
          "node_modules/left-pad/node_modules/transitive-thing": { version: "0.9.0" },
        },
      }),
    )
    process.env.ORCHESTRAI_SECURITY_EXTERNAL_DATA = "1"
    let queried: string[] = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("querybatch")) {
        const body = JSON.parse(String(init?.body))
        queried = body.queries.map((q: any) => q.package.name)
        return jsonResponse(200, { results: body.queries.map(() => ({ vulns: [] })) })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const id = await submit(`audit dependencies at ${dir}`)
    const task = await getTaskAfter(id, ["completed", "failed"])
    expect(task.status).toBe("completed")
    expect(task.result).toContain("=== Dependency Audit ===") // top header still unlabeled/unaffected
    expect(task.result).toContain("All dependencies are pinned.") // unpinned-check still from package.json alone
    expect(task.result).toContain("=== Known Vulnerabilities (OSV.dev, via package-lock.json) ===")
    expect(queried).toContain("transitive-thing") // the real proof: a dep package.json never declared
    rmSync(dir, { recursive: true, force: true })
  })
})


// specs/129 — the secrets walk never descends into OrchestrAI's own state
// dir, while a real finding elsewhere in the same project is still reported.
describe("specs/129 — scan-secrets skips .orchestrai", () => {
  test("a key under .orchestrai is never scanned; one in src still is", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-orchestrai-skip-"))
    try {
      mkdirSync(path.join(dir, ".orchestrai"))
      writeFileSync(path.join(dir, ".orchestrai", "leak.ts"), 'const k = "AKIAORCHESTRAISTATE99"\n')
      mkdirSync(path.join(dir, "src"))
      writeFileSync(path.join(dir, "src", "config.ts"), 'const k = "AKIAREALFINDING12345"\n')
      const id = `t-${randomUUID()}`
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, message: { role: "user", parts: [{ text: `scan for secrets at ${dir}` }] }, selectedSkill: "scan-secrets" }),
      })
      expect(res.status).toBe(200)
      const task = await getTaskAfter(id, ["completed", "failed"], 10000)
      expect(task.status).toBe("completed")
      expect(task.result).toContain("config.ts")
      expect(task.result).not.toContain(".orchestrai")
      expect(task.result).not.toContain("leak.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
