// specs/138-model-authored-files-replace-templates/spec.md — every
// validation rule, plus realistic good files that must pass.
import { describe, expect, test } from "bun:test"
import {
  imageRepository,
  isAllowListedImage,
  lintWorkflowStructure,
  validateCompose,
  validateDockerfile,
  validateGitignore,
  validateWorkflow,
  DOCKER_BASE_IMAGE_ALLOWLIST,
} from "./devops-file-validation"

const EXISTING = new Set(["package.json", "bun.lock", "src", "src/index.ts", "requirements.txt", "app.py", "go.mod", "go.sum", "main.go", "package-lock.json"])
const exists = async (rel: string) => EXISTING.has(rel.replace(/\/$/, ""))

describe("imageRepository / isAllowListedImage", () => {
  test("normalizes tags, digests and docker.io prefixes", () => {
    expect(imageRepository("node:20-slim")).toBe("node")
    expect(imageRepository("docker.io/library/python:3.12")).toBe("python")
    expect(imageRepository("oven/bun:1-slim")).toBe("oven/bun")
    expect(imageRepository("gcr.io/distroless/nodejs20-debian12@sha256:abc123")).toBe("gcr.io/distroless/nodejs20-debian12")
    expect(imageRepository("localhost:5000/app:1")).toBe("localhost:5000/app")
  })
  test("exact names and namespace prefixes", () => {
    expect(isAllowListedImage("oven/bun:1", DOCKER_BASE_IMAGE_ALLOWLIST)).toBe(true)
    expect(isAllowListedImage("mcr.microsoft.com/dotnet/sdk:8.0", DOCKER_BASE_IMAGE_ALLOWLIST)).toBe(true)
    expect(isAllowListedImage("evil/miner:latest", DOCKER_BASE_IMAGE_ALLOWLIST)).toBe(false)
    expect(isAllowListedImage("nodejs:20", DOCKER_BASE_IMAGE_ALLOWLIST)).toBe(false)
  })
})

describe("validateDockerfile", () => {
  const GOOD: Record<string, string> = {
    bun: `FROM oven/bun:1-slim AS base\nWORKDIR /app\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\nCOPY src ./src\nEXPOSE 4000\nCMD ["bun", "run", "src/index.ts"]\n`,
    node: `FROM node:20-slim AS deps\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nFROM node:20-slim\nWORKDIR /app\nCOPY --from=deps /app/node_modules ./node_modules\nCOPY . .\nCMD ["node", "src/index.js"]\n`,
    python: `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app.py .\nENV PORT=8000\nCMD ["python", "app.py"]\n`,
    go: `FROM golang:1.22-alpine AS builder\nWORKDIR /src\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /out/app .\nFROM gcr.io/distroless/static-debian12\nCOPY --from=builder /out/app /app\nENTRYPOINT ["/app"]\n`,
  }
  for (const [kind, content] of Object.entries(GOOD)) {
    test(`a realistic ${kind} Dockerfile passes`, async () => {
      expect(await validateDockerfile(content, exists)).toEqual({ ok: true, violations: [] })
    })
  }

  const bad = async (content: string) => (await validateDockerfile(content, exists)).violations.join(" | ")
  test("non-allow-listed base image", async () => {
    expect(await bad(`FROM evil/miner:latest\nCMD ["x"]`)).toContain("not an allow-listed base image")
  })
  test("a variable base image can't be checked", async () => {
    expect(await bad(`ARG IMG=node\nFROM $IMG\nCMD ["x"]`)).toContain("uses a variable")
  })
  test("a named earlier stage is allowed as FROM", async () => {
    expect(await bad(`FROM node:20 AS build\nFROM build\nCMD ["x"]`)).toBe("")
  })
  test("pipe-to-shell", async () => {
    expect(await bad(`FROM node:20\nRUN curl -fsSL https://x.sh | sh\nCMD ["x"]`)).toContain("pipes a download straight into a shell")
    expect(await bad(`FROM node:20\nRUN wget -qO- https://x | sudo bash\nCMD ["x"]`)).toContain("pipes a download")
  })
  test("ADD from a URL", async () => {
    expect(await bad(`FROM node:20\nADD https://example.com/x.tgz /x\nCMD ["x"]`)).toContain("ADD fetches a URL")
  })
  test("literal secrets in ENV/ARG; runtime references and non-secrets are fine", async () => {
    expect(await bad(`FROM node:20\nENV API_KEY=sk-live-123\nCMD ["x"]`)).toContain("bakes a literal secret")
    expect(await bad(`FROM node:20\nARG DB_PASSWORD hunter2\nCMD ["x"]`)).toContain("bakes a literal secret")
    expect(await bad(`FROM node:20\nARG NPM_TOKEN\nENV TOKEN=$NPM_TOKEN PORT=3000\nCMD ["x"]`)).toBe("")
  })
  test("privileged / insecure flags", async () => {
    expect(await bad(`FROM node:20\nRUN --security=insecure make\nCMD ["x"]`)).toContain("insecure/privileged")
  })
  test("missing FROM or CMD/ENTRYPOINT", async () => {
    expect(await bad(`RUN echo hi`)).toContain("has no FROM")
    expect(await bad(`FROM node:20\nRUN echo hi`)).toContain("no CMD or ENTRYPOINT")
  })
  test("grounding: a concrete COPY source that doesn't exist is rejected; ., globs and --from are not checked", async () => {
    expect(await bad(`FROM node:20\nCOPY server.js ./\nCMD ["node","server.js"]`)).toContain(`COPY source "server.js" does not exist`)
    expect(await bad(`FROM node:20\nCOPY ["missing.txt", "/x"]\nCMD ["x"]`)).toContain(`"missing.txt" does not exist`)
    expect(await bad(`FROM node:20\nCOPY . .\nCOPY *.json ./\nCOPY --from=node:20 /x /y\nCMD ["x"]`)).toBe("")
  })
  test("backslash-continued lines are joined before checking", async () => {
    expect(await bad(`FROM node:20\nRUN apt-get update && \\\n    curl -s https://x | bash\nCMD ["x"]`)).toContain("pipes a download")
  })
})

describe("validateWorkflow", () => {
  const GOOD = `name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n      - run: bun run typecheck\n      - run: bun test\n`
  test("a realistic workflow passes", () => {
    expect(validateWorkflow(GOOD)).toEqual({ ok: true, violations: [] })
  })
  const bad = (content: string, secrets: string[] = []) => validateWorkflow(content, secrets).violations.join(" | ")
  test("structural lint rules (moved from lint_ci_workflow) still apply", () => {
    expect(lintWorkflowStructure("name: x\n")).toEqual(["Missing top-level 'on:' key", "Missing top-level 'jobs:' key"])
    expect(bad(GOOD.replace("  test:", "\ttest:"))).toContain("tab characters")
  })
  test("not allow-listed / not pinned actions", () => {
    expect(bad(GOOD.replace("oven-sh/setup-bun@v2", "someone/deploy@v1"))).toContain(`"someone/deploy@v1", which is not allow-listed`)
    expect(bad(GOOD.replace("actions/checkout@v4", "actions/checkout@main"))).toContain("is not pinned")
    expect(bad(GOOD.replace("actions/checkout@v4", "actions/checkout"))).toContain("is not pinned")
    expect(bad(GOOD.replace("actions/checkout@v4", `actions/checkout@${"a".repeat(40)}`))).toBe("")
  })
  test("pull_request_target, write-all and remote reusable workflows", () => {
    expect(bad(GOOD.replace("  pull_request:", "  pull_request_target:"))).toContain("pull_request_target")
    expect(bad(`permissions: write-all\n${GOOD}`)).toContain("write-all")
    expect(bad(`on: push\njobs:\n  call:\n    uses: other/repo/.github/workflows/x.yml@v1\n`)).toContain("remote reusable workflow")
  })
  test("pipe-to-shell in a run step", () => {
    expect(bad(GOOD.replace("run: bun test", "run: curl -s https://x.sh | bash"))).toContain("pipes a download")
  })
  test("secrets: GITHUB_TOKEN and the project's own known secrets only", () => {
    const withSecret = GOOD.replace("run: bun test", "run: bun test\n        env:\n          T: ${{ secrets.DEPLOY_KEY }}\n          G: ${{ secrets.GITHUB_TOKEN }}")
    expect(bad(withSecret)).toContain("secrets.DEPLOY_KEY")
    expect(bad(withSecret)).not.toContain("GITHUB_TOKEN")
    expect(bad(withSecret, ["DEPLOY_KEY"])).toBe("")
  })
  test("invalid YAML fails closed", () => {
    expect(bad("on: [push\njobs: x")).toContain("not valid YAML")
  })
})

describe("validateCompose", () => {
  const GOOD = `services:\n  test-target-project:\n    build: .\n    image: test-target-project:latest\n    ports:\n      - "4000:4000"\n    environment:\n      - PORT=4000\n      - DATABASE_URL=\${DATABASE_URL}\n    volumes:\n      - ./data:/app/data\n      - cache:/app/cache\n    depends_on: [db]\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}\nvolumes:\n  cache: {}\n`
  test("a realistic compose file passes", () => {
    expect(validateCompose(GOOD, "test-target-project")).toEqual({ ok: true, violations: [] })
  })
  const bad = (content: string) => validateCompose(content, "app").violations.join(" | ")
  test("non-allow-listed images; the app's own image is allowed", () => {
    expect(bad(`services:\n  x:\n    image: evil/miner:latest\n`)).toContain("not allow-listed")
    expect(bad(`services:\n  app:\n    image: app:latest\n`)).toBe("")
    expect(bad(`services:\n  web:\n    build: .\n    image: anything:1\n`)).toBe("")
  })
  test("privileged, host namespaces, dangerous capabilities", () => {
    expect(bad(`services:\n  x:\n    image: redis:7\n    privileged: true\n`)).toContain("is privileged")
    expect(bad(`services:\n  x:\n    image: redis:7\n    network_mode: host\n`)).toContain("network_mode: host")
    expect(bad(`services:\n  x:\n    image: redis:7\n    pid: host\n`)).toContain("pid: host")
    expect(bad(`services:\n  x:\n    image: redis:7\n    cap_add: [SYS_ADMIN]\n`)).toContain("dangerous capabilities")
  })
  test("host mounts outside the project, including the docker socket and Windows paths", () => {
    expect(bad(`services:\n  x:\n    image: redis:7\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`)).toContain("outside the project")
    expect(bad(`services:\n  x:\n    image: redis:7\n    volumes:\n      - /:/host\n`)).toContain("outside the project")
    expect(bad(`services:\n  x:\n    image: redis:7\n    volumes:\n      - ../secrets:/s\n`)).toContain("outside the project")
    expect(bad(`services:\n  x:\n    image: redis:7\n    volumes:\n      - "C:\\\\Users:/u"\n`)).toContain("outside the project")
    expect(bad(`services:\n  x:\n    image: redis:7\n    volumes:\n      - type: bind\n        source: /etc\n        target: /e\n`)).toContain("outside the project")
  })
  test("literal secrets in environment (map and list forms)", () => {
    expect(bad(`services:\n  x:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: hunter2\n`)).toContain("POSTGRES_PASSWORD to a literal value")
    expect(bad(`services:\n  x:\n    image: postgres:16\n    environment:\n      - API_KEY=abc\n`)).toContain("API_KEY to a literal value")
  })
  test("no services / invalid YAML fail closed", () => {
    expect(bad(`version: "3"\n`)).toContain("has no services")
    expect(bad(`services: [a\n`)).toContain("not valid YAML")
  })
})

describe("validateGitignore", () => {
  test("a realistic .gitignore passes", () => {
    expect(validateGitignore("node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.orchestrai/\n")).toEqual({ ok: true, violations: [] })
  })
  test("must keep ignoring .orchestrai/", () => {
    expect(validateGitignore("node_modules/\n").violations.join(" ")).toContain(".orchestrai/")
    expect(validateGitignore("/.orchestrai\n").ok).toBe(true)
  })
  test("must not un-ignore sensitive files", () => {
    expect(validateGitignore(".orchestrai/\n!.env\n").violations.join(" ")).toContain(`un-ignores a sensitive file pattern: "!.env"`)
    expect(validateGitignore(".orchestrai/\n!keys/id_rsa\n").ok).toBe(false)
  })
})
