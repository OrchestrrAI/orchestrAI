import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
  assertCatalogCurrent,
  buildJsonCatalog,
  buildMarkdownCatalog,
  checkClaudeMdSize,
  CLAUDE_MD_MAX_CHARACTERS,
  discoverSpecSources,
  parseAndValidateSpecs,
  parseSpec,
  type SpecSource,
} from "./spec-catalog"

function source(id: string, overrides: Record<string, unknown> = {}): SpecSource {
  const metadata: Record<string, unknown> = {
    id,
    title: id.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" "),
    area: "test-area",
    change_type: "feature",
    status: "implemented",
    verification: "verified",
    created: "2026-08-01",
    updated: "2026-08-02",
    approved_by: "Yusuf",
    approved_on: "2026-08-01",
    implemented_on: "2026-08-02",
    amends: [],
    supersedes: [],
    superseded_by: [],
    related: [],
    ...overrides,
  }
  const title = String(metadata.title)
  const yaml = Object.entries(metadata).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(", ")}]`
    if (value === null) return `${key}: null`
    return `${key}: ${value}`
  }).join("\n")
  return { filename: `${id}/spec.md`, content: `---\n${yaml}\n---\n# Spec: ${title}\n` }
}

describe("spec metadata governance", () => {
  test("parses a valid governed spec", () => {
    expect(parseSpec(source("001-valid-spec")).metadata.id).toBe("001-valid-spec")
  })

  test("rejects missing and malformed metadata", () => {
    expect(() => parseSpec({ filename: "001-bad/spec.md", content: "# Spec: Bad\n" })).toThrow("missing YAML frontmatter")
    const missingArea = source("001-missing-area")
    expect(() => parseSpec({ ...missingArea, content: missingArea.content.replace(/^area:.*\n/m, "") })).toThrow("missing required key area")
    expect(() => parseSpec(source("001-bad", { status: "finished" }))).toThrow("status must be one of")
    expect(() => parseSpec(source("001-bad", { area: "Not Valid" }))).toThrow("area must be lower-case kebab-case")
    expect(() => parseSpec(source("001-bad", { change_type: "rewrite" }))).toThrow("change_type must be one of")
  })

  test("rejects filename/id mismatches and duplicate ids", () => {
    expect(() => parseSpec({ ...source("001-alpha"), filename: "002-beta/spec.md" })).toThrow("id must match parent directory")
    const duplicate = source("001-alpha")
    expect(() => parseAndValidateSpecs([duplicate, duplicate])).toThrow("duplicate id 001-alpha")
  })

  test("rejects invalid lifecycle combinations", () => {
    expect(() => parseSpec(source("001-draft-spec", {
      status: "draft",
      verification: "pending",
      approved_by: "Yusuf",
      approved_on: "2026-08-01",
      implemented_on: null,
    }))).toThrow("draft specs cannot contain approval")

    const draft = source("002-unchecked-draft", {
      status: "draft",
      verification: "pending",
      approved_by: null,
      approved_on: null,
      implemented_on: null,
    })
    expect(() => parseSpec({ ...draft, content: `${draft.content}\n- [x] Already implemented\n` })).toThrow("cannot claim completed acceptance")
  })

  test("rejects missing reciprocal supersession and broken references", () => {
    const oldSpec = source("001-old-spec", { status: "superseded", superseded_by: ["002-new-spec"] })
    const newSpec = source("002-new-spec", { supersedes: [] })
    expect(() => parseAndValidateSpecs([oldSpec, newSpec])).toThrow("reciprocal supersedes link is missing")
    expect(() => parseAndValidateSpecs([source("001-lonely", { related: ["999-missing"] })])).toThrow("does not exist")
  })

  test("rejects supersession cycles", () => {
    const alpha = source("001-alpha", { status: "superseded", supersedes: ["002-beta"], superseded_by: ["002-beta"] })
    const beta = source("002-beta", { status: "superseded", supersedes: ["001-alpha"], superseded_by: ["001-alpha"] })
    expect(() => parseAndValidateSpecs([alpha, beta])).toThrow("supersession cycle")
  })

  test("validates one-way amendments and rejects invalid amendment graphs", () => {
    const original = source("001-original")
    const amendment = source("002-amendment", { change_type: "enhancement", amends: ["001-original"] })
    expect(parseAndValidateSpecs([original, amendment])).toHaveLength(2)

    expect(() => parseSpec(source("003-self", { amends: ["003-self"] }))).toThrow("amends cannot reference the spec itself")
    expect(() => parseSpec(source("003-duplicate", { amends: ["001-original", "001-original"] }))).toThrow("amends contains duplicate id")
    expect(() => parseAndValidateSpecs([source("001-lonely", { amends: ["999-missing"] })])).toThrow("does not exist")

    const alpha = source("001-alpha", { amends: ["002-beta"] })
    const beta = source("002-beta", { amends: ["001-alpha"] })
    expect(() => parseAndValidateSpecs([alpha, beta])).toThrow("amendment cycle")
  })

  test("catalog output is deterministic and stale output is rejected", () => {
    const specs = parseAndValidateSpecs([
      source("002-zulu", { area: "zulu-area", change_type: "enhancement", amends: ["001-alpha"] }),
      { ...source("001-alpha", { area: "alpha-area" }), hasPlan: true, hasVerification: true },
    ])
    const json = JSON.parse(buildJsonCatalog(specs))
    const markdown = buildMarkdownCatalog(specs)
    expect(json.schema_version).toBe(3)
    expect(json.areas).toEqual([
      { id: "alpha-area", specs: ["001-alpha"] },
      { id: "zulu-area", specs: ["002-zulu"] },
    ])
    expect(json.specs[0].amended_by).toEqual(["002-zulu"])
    expect(json.specs[1].amended_by).toEqual([])
    expect(markdown.indexOf("## `alpha-area`")).toBeLessThan(markdown.indexOf("## `zulu-area`"))
    expect(markdown).toContain("[\`001-alpha\`](./001-alpha/spec.md)")
    expect(markdown).toContain("[plan](./001-alpha/plan.md), [verification](./001-alpha/verification.md)")
    expect(markdown).toContain("| `implemented` | 2 |")
    expect(markdown).toContain("`002-zulu`")
    expect(() => assertCatalogCurrent("old", "new", "specs/catalog.json")).toThrow("run bun run specs:catalog")
  })

  test("discovers numbered specification folders and optional artifacts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "orchestrai-specs-"))
    try {
      await mkdir(resolve(root, "schema"))
      await mkdir(resolve(root, "templates"))
      await mkdir(resolve(root, "001-alpha"))
      await writeFile(resolve(root, "001-alpha", "spec.md"), source("001-alpha").content)
      await writeFile(resolve(root, "001-alpha", "plan.md"), "# Plan\n")
      const sources = await discoverSpecSources(root)
      expect(sources).toHaveLength(1)
      expect(sources[0]!.filename).toBe("001-alpha/spec.md")
      expect(sources[0]!.hasPlan).toBe(true)
      expect(sources[0]!.hasVerification).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("CLAUDE.md size budget accepts under and exactly at the limit, naming the count", () => {
    const zero = checkClaudeMdSize(0)
    expect(zero.ok).toBe(true)
    expect(zero.message).toContain("CLAUDE.md is 0 characters")
    expect(zero.message).toContain(`${CLAUDE_MD_MAX_CHARACTERS}`)
    const under = checkClaudeMdSize(CLAUDE_MD_MAX_CHARACTERS - 1)
    expect(under.ok).toBe(true)
    expect(under.message).toContain(`${CLAUDE_MD_MAX_CHARACTERS - 1}`)
    expect(under.message).toContain(`${CLAUDE_MD_MAX_CHARACTERS}`)
    const atLimit = checkClaudeMdSize(CLAUDE_MD_MAX_CHARACTERS)
    expect(atLimit.ok).toBe(true)
    expect(atLimit.message).toContain(`${CLAUDE_MD_MAX_CHARACTERS}`)
  })

  test("CLAUDE.md size budget rejects over the limit, naming count, budget, and overage", () => {
    const over = checkClaudeMdSize(CLAUDE_MD_MAX_CHARACTERS + 42)
    expect(over.ok).toBe(false)
    expect(over.message).toContain(`${CLAUDE_MD_MAX_CHARACTERS + 42}`)
    expect(over.message).toContain(`${CLAUDE_MD_MAX_CHARACTERS}`)
    expect(over.message).toContain("42 over")
    expect(over.message).toContain("specs/118")
  })

  test("rejects legacy, malformed, and missing-spec layouts", async () => {
    const legacyRoot = await mkdtemp(resolve(tmpdir(), "orchestrai-specs-legacy-"))
    const malformedRoot = await mkdtemp(resolve(tmpdir(), "orchestrai-specs-malformed-"))
    const missingRoot = await mkdtemp(resolve(tmpdir(), "orchestrai-specs-missing-"))
    try {
      await writeFile(resolve(legacyRoot, "legacy.spec.md"), "legacy")
      await mkdir(resolve(malformedRoot, "feature-without-number"))
      await mkdir(resolve(missingRoot, "001-missing"))
      await expect(discoverSpecSources(legacyRoot)).rejects.toThrow("root-level legacy specs are forbidden")
      await expect(discoverSpecSources(malformedRoot)).rejects.toThrow("specification directory must match")
      await expect(discoverSpecSources(missingRoot)).rejects.toThrow("missing required spec.md")
    } finally {
      await Promise.all([
        rm(legacyRoot, { recursive: true, force: true }),
        rm(malformedRoot, { recursive: true, force: true }),
        rm(missingRoot, { recursive: true, force: true }),
      ])
    }
  })
})
