// specs/085-multi-ecosystem-dependency-audit/spec.md (original home:
// packages/agents/security/dependency-manifests.ts) — moved verbatim to
// packages/shared by specs/099-tui-port-url-and-analyze-project-stack-
// awareness/spec.md so a second, genuinely independent consumer
// (packages/mcp/index.ts's own analyze_project tool) can reuse it
// without importing an agent-specific module into this codebase's
// foundational, agent-agnostic MCP layer — packages/mcp is used
// directly by DevOps/Code Review/Coder as MCP clients, plus the
// external stdio/HTTP surface, and never depends on any one agent's own
// package. packages/agents/security/dependency-manifests.ts re-exports
// both symbols below unchanged, so every existing import site stays
// byte-identical. Behavior is completely unchanged from the original —
// same fixed detection order (npm first, then PyPI, Go, Packagist,
// Maven), same "first manifest found wins" rule, no execution, pure
// file-presence checks only.
import { existsSync } from "fs"
import * as path from "path"

export type Ecosystem = "npm" | "PyPI" | "Go" | "Packagist" | "Maven"

export interface EcosystemDetection {
  ecosystem: Ecosystem
  manifestFile: string
}

export function detectEcosystem(projectPath: string): EcosystemDetection | null {
  if (existsSync(path.join(projectPath, "package.json"))) return { ecosystem: "npm", manifestFile: "package.json" }
  if (existsSync(path.join(projectPath, "requirements.txt"))) return { ecosystem: "PyPI", manifestFile: "requirements.txt" }
  if (existsSync(path.join(projectPath, "pyproject.toml"))) return { ecosystem: "PyPI", manifestFile: "pyproject.toml" }
  if (existsSync(path.join(projectPath, "go.mod"))) return { ecosystem: "Go", manifestFile: "go.mod" }
  if (existsSync(path.join(projectPath, "composer.json"))) return { ecosystem: "Packagist", manifestFile: "composer.json" }
  if (existsSync(path.join(projectPath, "pom.xml"))) return { ecosystem: "Maven", manifestFile: "pom.xml" }
  return null
}

export const MANIFEST_FILES_CHECKED = [
  "package.json", "requirements.txt", "pyproject.toml", "go.mod", "composer.json", "pom.xml",
] as const
