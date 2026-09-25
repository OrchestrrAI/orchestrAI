import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseDocument } from "yaml"

export const STATUSES = [
  "draft",
  "approved",
  "implemented",
  "superseded",
  "archived",
] as const

export const VERIFICATIONS = [
  "pending",
  "partial",
  "verified",
  "not-applicable",
] as const

export const CHANGE_TYPES = [
  "feature",
  "enhancement",
  "fix",
  "migration",
  "spike",
  "governance",
] as const

type Status = (typeof STATUSES)[number]
type Verification = (typeof VERIFICATIONS)[number]
type ChangeType = (typeof CHANGE_TYPES)[number]

export interface SpecMetadata {
  id: string
  title: string
  area: string
  change_type: ChangeType
  status: Status
  verification: Verification
  created: string | null
  updated: string
  approved_by: string | null
  approved_on: string | null
  implemented_on: string | null
  amends: string[]
  supersedes: string[]
  superseded_by: string[]
  related: string[]
}

export interface ParsedSpec {
  filename: string
  metadata: SpecMetadata
  body: string
  hasPlan: boolean
  hasVerification: boolean
}

export interface SpecSource {
  filename: string
  content: string
  hasPlan?: boolean
  hasVerification?: boolean
}

const REQUIRED_KEYS = [
  "id",
  "title",
  "area",
  "change_type",
  "status",
  "verification",
  "created",
  "updated",
  "approved_by",
  "approved_on",
  "implemented_on",
  "amends",
  "supersedes",
  "superseded_by",
  "related",
] as const

const ID_PATTERN = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/
const AREA_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SPEC_DIRECTORY_PATTERN = ID_PATTERN
const SPEC_PATH_PATTERN = /^(\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*)\/spec\.md$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateDate(value: unknown, key: string, nullable: boolean, errors: string[]): void {
  if (nullable && value === null) return
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    errors.push(`${key} must be ${nullable ? "null or " : ""}a valid YYYY-MM-DD date`)
  }
}

function validateIdList(value: unknown, key: string, ownId: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array`)
    return
  }

  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string" || !ID_PATTERN.test(item)) {
      errors.push(`${key} contains invalid spec id ${JSON.stringify(item)}`)
      continue
    }
    if (item === ownId) errors.push(`${key} cannot reference the spec itself`)
    if (seen.has(item)) errors.push(`${key} contains duplicate id ${item}`)
    seen.add(item)
  }
}

export function parseSpec(source: SpecSource): ParsedSpec {
  const normalized = source.content.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) {
    throw new Error(`${source.filename}: missing YAML frontmatter at byte 0`)
  }

  const closingIndex = normalized.indexOf("\n---\n", 4)
  if (closingIndex < 0) {
    throw new Error(`${source.filename}: YAML frontmatter has no closing --- marker`)
  }

  const yamlText = normalized.slice(4, closingIndex)
  const body = normalized.slice(closingIndex + 5).replace(/^\n+/, "")
  const document = parseDocument(yamlText, {
    schema: "core",
    uniqueKeys: true,
  })

  if (document.errors.length > 0) {
    throw new Error(`${source.filename}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`)
  }

  const raw: unknown = document.toJS({ maxAliasCount: 0 })
  if (!isRecord(raw)) throw new Error(`${source.filename}: frontmatter must be a mapping`)

  const errors: string[] = []
  const actualKeys = Object.keys(raw)
  for (const key of REQUIRED_KEYS) {
    if (!(key in raw)) errors.push(`missing required key ${key}`)
  }
  for (const key of actualKeys) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) errors.push(`unknown key ${key}`)
  }

  const normalizedFilename = source.filename.replace(/\\/g, "/")
  const pathMatch = normalizedFilename.match(SPEC_PATH_PATTERN)
  const expectedId = pathMatch?.[1] ?? "<invalid-directory>"
  if (!pathMatch) errors.push("path must match <NNN-kebab-case-id>/spec.md")
  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) errors.push("id must match NNN-kebab-case")
  if (raw.id !== expectedId) errors.push(`id must match parent directory (${expectedId})`)
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) errors.push("title must be a non-empty string")
  if (typeof raw.area !== "string" || !AREA_PATTERN.test(raw.area)) errors.push("area must be lower-case kebab-case")
  if (!CHANGE_TYPES.includes(raw.change_type as ChangeType)) {
    errors.push(`change_type must be one of: ${CHANGE_TYPES.join(", ")}`)
  }
  if (!STATUSES.includes(raw.status as Status)) errors.push(`status must be one of: ${STATUSES.join(", ")}`)
  if (!VERIFICATIONS.includes(raw.verification as Verification)) {
    errors.push(`verification must be one of: ${VERIFICATIONS.join(", ")}`)
  }
  validateDate(raw.created, "created", true, errors)
  validateDate(raw.updated, "updated", false, errors)
  if (raw.approved_by !== null && (typeof raw.approved_by !== "string" || raw.approved_by.trim().length === 0)) {
    errors.push("approved_by must be null or a non-empty string")
  }
  validateDate(raw.approved_on, "approved_on", true, errors)
  validateDate(raw.implemented_on, "implemented_on", true, errors)

  const ownId = typeof raw.id === "string" ? raw.id : expectedId
  validateIdList(raw.amends, "amends", ownId, errors)
  validateIdList(raw.supersedes, "supersedes", ownId, errors)
  validateIdList(raw.superseded_by, "superseded_by", ownId, errors)
  validateIdList(raw.related, "related", ownId, errors)

  if (raw.status === "draft") {
    if (raw.approved_by !== null || raw.approved_on !== null || raw.implemented_on !== null) {
      errors.push("draft specs cannot contain approval or implementation metadata")
    }
    if (raw.verification !== "pending" && raw.verification !== "not-applicable") {
      errors.push("draft specs must have pending or not-applicable verification")
    }
    if (/^- \[[xX]\]/m.test(body)) {
      errors.push("draft specs cannot claim completed acceptance criteria")
    }
  }

  if (raw.status === "approved") {
    if (raw.approved_by === null || raw.approved_on === null) errors.push("approved specs require approval metadata")
    if (raw.implemented_on !== null) errors.push("approved specs cannot have implemented_on")
  }

  if (raw.status === "implemented" || raw.status === "superseded") {
    if (raw.approved_by === null || raw.approved_on === null) errors.push(`${raw.status} specs require approval metadata`)
    if (raw.implemented_on === null) errors.push(`${raw.status} specs require implemented_on`)
  }

  if (raw.status === "superseded" && Array.isArray(raw.superseded_by) && raw.superseded_by.length === 0) {
    errors.push("superseded specs require at least one superseded_by id")
  }

  if (typeof raw.created === "string" && typeof raw.updated === "string" && raw.created > raw.updated) {
    errors.push("created cannot be after updated")
  }
  if (typeof raw.approved_on === "string" && typeof raw.implemented_on === "string" && raw.approved_on > raw.implemented_on) {
    errors.push("approved_on cannot be after implemented_on")
  }

  if (typeof raw.title === "string" && !body.startsWith(`# Spec: ${raw.title}\n`)) {
    errors.push(`first body heading must be # Spec: ${raw.title}`)
  }

  if (errors.length > 0) throw new Error(`${source.filename}:\n- ${errors.join("\n- ")}`)
  return {
    filename: normalizedFilename,
    metadata: raw as unknown as SpecMetadata,
    body,
    hasPlan: source.hasPlan ?? false,
    hasVerification: source.hasVerification ?? false,
  }
}

export function validateRelationships(specs: ParsedSpec[]): void {
  const byId = new Map<string, ParsedSpec>()
  const errors: string[] = []
  for (const spec of specs) {
    if (byId.has(spec.metadata.id)) errors.push(`duplicate id ${spec.metadata.id}`)
    byId.set(spec.metadata.id, spec)
  }

  for (const spec of specs) {
    const { id, amends, supersedes, superseded_by: supersededBy, related } = spec.metadata
    for (const referenced of [...amends, ...supersedes, ...supersededBy, ...related]) {
      if (!byId.has(referenced)) errors.push(`${id}: referenced spec ${referenced} does not exist`)
    }
    for (const olderId of supersedes) {
      const older = byId.get(olderId)
      if (older && !older.metadata.superseded_by.includes(id)) {
        errors.push(`${id}: supersedes ${olderId}, but the reciprocal superseded_by link is missing`)
      }
    }
    for (const newerId of supersededBy) {
      const newer = byId.get(newerId)
      if (newer && !newer.metadata.supersedes.includes(id)) {
        errors.push(`${id}: superseded_by ${newerId}, but the reciprocal supersedes link is missing`)
      }
    }
  }

  const findCycles = (relationship: "supersedes" | "amends", label: string): void => {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string, path: string[]): void => {
      if (visiting.has(id)) {
        errors.push(`${label} cycle: ${[...path, id].join(" -> ")}`)
        return
      }
      if (visited.has(id)) return
      visiting.add(id)
      const spec = byId.get(id)
      for (const olderId of spec?.metadata[relationship] ?? []) visit(olderId, [...path, id])
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of byId.keys()) visit(id, [])
  }

  findCycles("supersedes", "supersession")
  findCycles("amends", "amendment")

  if (errors.length > 0) throw new Error(errors.join("\n"))
}

export function deriveAmendedBy(specs: ParsedSpec[]): Map<string, string[]> {
  const amendedBy = new Map(specs.map((spec) => [spec.metadata.id, [] as string[]]))
  for (const spec of specs) {
    for (const olderId of spec.metadata.amends) amendedBy.get(olderId)?.push(spec.metadata.id)
  }
  for (const ids of amendedBy.values()) ids.sort()
  return amendedBy
}

export function buildAreaIndex(specs: ParsedSpec[]): Array<{ id: string; specs: string[] }> {
  const areas = new Map<string, string[]>()
  for (const spec of specs) {
    const ids = areas.get(spec.metadata.area) ?? []
    ids.push(spec.metadata.id)
    areas.set(spec.metadata.area, ids)
  }
  return [...areas.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, ids]) => ({ id, specs: ids.sort() }))
}

export function parseAndValidateSpecs(sources: SpecSource[]): ParsedSpec[] {
  const parsed = sources.map(parseSpec).sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))
  validateRelationships(parsed)
  return parsed
}

function displayDate(value: string | null): string {
  return value ?? "—"
}

function displayIds(ids: string[]): string {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(", ") : "—"
}

export function buildMarkdownCatalog(specs: ParsedSpec[]): string {
  const amendedBy = deriveAmendedBy(specs)
  const statusRows = STATUSES.map((status) => `| \`${status}\` | ${specs.filter((spec) => spec.metadata.status === status).length} |`)
  const verificationRows = VERIFICATIONS.map((verification) => `| \`${verification}\` | ${specs.filter((spec) => spec.metadata.verification === verification).length} |`)
  const sections = buildAreaIndex(specs).map(({ id: area }) => {
    const entries = specs.filter((spec) => spec.metadata.area === area)
    const rows = entries.map(({ filename, metadata, hasPlan, hasVerification }) => {
      const artifacts = [
        hasPlan ? `[plan](./${metadata.id}/plan.md)` : null,
        hasVerification ? `[verification](./${metadata.id}/verification.md)` : null,
      ].filter(Boolean).join(", ") || "—"
      return `| [\`${metadata.id}\`](./${filename}) | ${metadata.title} | \`${metadata.change_type}\` | \`${metadata.status}\` | \`${metadata.verification}\` | ${artifacts} | ${metadata.updated} | ${displayDate(metadata.approved_on)} | ${displayDate(metadata.implemented_on)} | ${displayIds(metadata.amends)} | ${displayIds(amendedBy.get(metadata.id) ?? [])} | ${displayIds(metadata.supersedes)} | ${displayIds(metadata.superseded_by)} |`
    })
    return `## \`${area}\`\n\n| ID | Title | Type | Status | Verification | Artifacts | Updated | Approved | Implemented | Amends | Amended by | Supersedes | Superseded by |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}`
  })

  return `# OrchestrAI Specification Governance and Catalog

This directory is the source of truth for intended behavior and acceptance
criteria. Runtime truth remains the current code when documents drift.

## Authoring workflow

1. Allocate the next immutable three-digit sequence and create
   \`<NNN-kebab-case-id>/spec.md\` from
   [\`templates/spec-template.md\`](./templates/spec-template.md), with metadata
   matching [\`schema/spec.schema.json\`](./schema/spec.schema.json).
2. Assign one stable primary \`area\`, one \`change_type\`, and any one-way
   \`amends\` links. Use \`related\` only for untyped cross-cutting context.
3. Keep lifecycle \`status\` separate from \`verification\` confidence.
4. Present a \`draft\` for review; do not implement it before explicit approval.
5. Keep newly discovered in-scope work in the same draft. Create a later
   checkpoint only when an implemented decision needs independent approval,
   migration, risk control, or verification.
6. A material post-approval scope change returns the spec to \`draft\`.
7. Use one-way \`amends\` for a partial extension. Record whole-spec
   \`supersedes\` / \`superseded_by\` replacement in both specs.
8. Run \`bun run specs:catalog\`, then \`bun run specs:check\`.

Only \`spec.md\` is mandatory. Add \`plan.md\` for multi-phase/risky work and
\`verification.md\` for substantial evidence; never create empty companion
files. Plans cannot broaden an approved spec, and verification artifacts do not
own lifecycle status independently.

Where history lives — one ownership rule, stated identically in \`CLAUDE.md\`
and \`AGENTS.md\`:

| File | Owns |
|---|---|
| \`CLAUDE.md\` | Current architecture, conventions, gates, commands. Present tense. Budget-capped. |
| \`specs/<NNN>/spec.md\` | The approved decision and its acceptance criteria. |
| \`specs/<NNN>/verification.md\` | That checkpoint's evidence **and its narrative record** — what was live-caught, what was tried, what a pass found. |
| \`context/worklog.md\` | Dated, per-work-unit handoff entries. Append-only. |
| \`context/history.md\` | Pre-spec-governance historical discussion. Frozen; not appended to. |

A checkpoint's narrative goes to its own \`verification.md\`, never to
\`CLAUDE.md\`; \`CLAUDE.md\` gains at most a present-tense sentence plus a spec
pointer, and \`bun run specs:check\` enforces its 150,000-character budget.

## Lifecycle model

| Status | Meaning |
|---|---|
| \`draft\` | Under review; implementation is not authorized. |
| \`approved\` | Explicitly approved; implementation may begin. |
| \`implemented\` | Approved behavior exists in the repository. |
| \`superseded\` | A later spec replaces this governing decision. |
| \`archived\` | Retained as history and no longer active guidance. |

| Verification | Meaning |
|---|---|
| \`pending\` | Required verification has not run. |
| \`partial\` | Implementation exists, but named checks remain incomplete. |
| \`verified\` | All required acceptance evidence is recorded. |
| \`not-applicable\` | No implementation verification applies; the spec must explain why. |

Normal progression is \`draft → approved → implemented\`. Verification is
independent. A material change after approval returns the spec to \`draft\`
and clears approval metadata. Supersession links must be reciprocal.

## Area and checkpoint model

An \`area\` is a long-lived feature or engineering initiative. Each numbered
directory is an immutable specification/checkpoint, and one area may contain
many checkpoints. The six change types are \`feature\`, \`enhancement\`,
\`fix\`, \`migration\`, \`spike\`, and \`governance\`.

\`amends\` changes part of an older checkpoint without invalidating its history;
the catalog derives the reverse \`amended by\` relationship. \`supersedes\`
means whole-spec replacement and remains reciprocal. Do not create a new
checkpoint for a tiny correction already inside an approved scope.

Do not hand-edit the catalog below or \`catalog.json\`; both are generated from
spec frontmatter. Numbered specification/checkpoint directory names are stable
creation IDs, not priorities, and must never be renumbered.

<!-- GENERATED:SPEC-CATALOG:START -->

## Lifecycle summary

| Status | Count |
|---|---:|
${statusRows.join("\n")}

| Verification | Count |
|---|---:|
${verificationRows.join("\n")}

## Specifications by area

${sections.join("\n\n")}

<!-- GENERATED:SPEC-CATALOG:END -->
`
}

export function buildJsonCatalog(specs: ParsedSpec[]): string {
  const amendedBy = deriveAmendedBy(specs)
  return `${JSON.stringify({
    schema_version: 3,
    areas: buildAreaIndex(specs),
    specs: specs.map(({ filename, metadata, hasPlan, hasVerification }) => ({
      path: filename,
      plan_path: hasPlan ? `${metadata.id}/plan.md` : null,
      verification_path: hasVerification ? `${metadata.id}/verification.md` : null,
      ...metadata,
      amended_by: amendedBy.get(metadata.id) ?? [],
    })),
  }, null, 2)}\n`
}

export function assertCatalogCurrent(actual: string, expected: string, filename: string): void {
  if (actual.replace(/\r\n/g, "\n") !== expected) {
    throw new Error(`${filename} is stale; run bun run specs:catalog`)
  }
}

export const CLAUDE_MD_MAX_CHARACTERS = 150_000

export interface ClaudeMdSizeCheck {
  ok: boolean
  message: string
}

export function checkClaudeMdSize(characters: number): ClaudeMdSizeCheck {
  if (characters > CLAUDE_MD_MAX_CHARACTERS) {
    const overage = characters - CLAUDE_MD_MAX_CHARACTERS
    return {
      ok: false,
      message:
        `CLAUDE.md is ${characters} characters, ${overage} over the ` +
        `${CLAUDE_MD_MAX_CHARACTERS}-character budget. Relocate per-spec historical ` +
        `narrative into specs/<NNN>/verification.md (see specs/118) and keep ` +
        `CLAUDE.md to present-tense current state.`,
    }
  }
  return {
    ok: true,
    message: `CLAUDE.md is ${characters} characters, within the ${CLAUDE_MD_MAX_CHARACTERS}-character budget.`,
  }
}

export async function discoverSpecSources(specsDirectory: string): Promise<SpecSource[]> {
  const entries = await readdir(specsDirectory, { withFileTypes: true })
  const errors: string[] = []
  const sources: SpecSource[] = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".spec.md")) {
      errors.push(`${entry.name}: root-level legacy specs are forbidden; use <NNN-id>/spec.md`)
      continue
    }
    if (!entry.isDirectory() || entry.name === "schema" || entry.name === "templates") continue
    if (!SPEC_DIRECTORY_PATTERN.test(entry.name)) {
      errors.push(`${entry.name}: specification directory must match NNN-kebab-case`)
      continue
    }

    const directory = resolve(specsDirectory, entry.name)
    const childNames = await readdir(directory)
    if (!childNames.includes("spec.md")) {
      errors.push(`${entry.name}: missing required spec.md`)
      continue
    }
    sources.push({
      filename: `${entry.name}/spec.md`,
      content: await readFile(resolve(directory, "spec.md"), "utf8"),
      hasPlan: childNames.includes("plan.md"),
      hasVerification: childNames.includes("verification.md"),
    })
  }

  if (errors.length > 0) throw new Error(errors.sort().join("\n"))
  return sources.sort((a, b) => a.filename.localeCompare(b.filename))
}

export async function runCatalog(mode: "check" | "write", repositoryRoot = process.cwd()): Promise<void> {
  const specsDirectory = resolve(repositoryRoot, "specs")
  const specs = parseAndValidateSpecs(await discoverSpecSources(specsDirectory))
  const markdown = buildMarkdownCatalog(specs)
  const json = buildJsonCatalog(specs)
  const markdownPath = resolve(specsDirectory, "README.md")
  const jsonPath = resolve(specsDirectory, "catalog.json")

  if (mode === "write") {
    await writeFile(markdownPath, markdown, "utf8")
    await writeFile(jsonPath, json, "utf8")
    console.log(`Generated spec catalogs for ${specs.length} specs.`)
    return
  }

  let actualMarkdown: string
  let actualJson: string
  try {
    ;[actualMarkdown, actualJson] = await Promise.all([
      readFile(markdownPath, "utf8"),
      readFile(jsonPath, "utf8"),
    ])
  } catch {
    throw new Error("spec catalog outputs are missing; run bun run specs:catalog")
  }
  assertCatalogCurrent(actualMarkdown, markdown, "specs/README.md")
  assertCatalogCurrent(actualJson, json, "specs/catalog.json")
  const claudeMdPath = resolve(repositoryRoot, "CLAUDE.md")
  let claudeMd: string
  try {
    claudeMd = await readFile(claudeMdPath, "utf8")
  } catch {
    throw new Error("CLAUDE.md is missing; the spec governance check requires it")
  }
  const claudeMdSize = checkClaudeMdSize(claudeMd.length)
  if (!claudeMdSize.ok) throw new Error(claudeMdSize.message)
  console.log(claudeMdSize.message)
  console.log(`Spec governance check passed for ${specs.length} specs.`)
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== "check" && mode !== "write") {
    console.error("Usage: bun run scripts/spec-catalog.ts <check|write>")
    process.exit(2)
  }
  runCatalog(mode).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
