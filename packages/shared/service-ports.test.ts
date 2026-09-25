// specs/099-tui-port-url-and-analyze-project-stack-awareness/spec.md —
// the first dedicated test file for resolveServicePort() (a real,
// previously-undiscovered gap: this function had no test coverage at
// all before this spec, despite being the exact building block the
// TUI's own port bug needed and never used). No network calls, no
// filesystem access — resolveServicePort() reads only its own env
// argument.
import { describe, expect, test } from "bun:test"
import { DEFAULT_SERVICE_PORTS, SERVICE_PORT_ENV_VARS, resolveServicePort } from "./service-ports"

describe("resolveServicePort", () => {
  test("unset env falls back to the real default for every service", () => {
    for (const service of Object.keys(DEFAULT_SERVICE_PORTS) as (keyof typeof DEFAULT_SERVICE_PORTS)[]) {
      expect(resolveServicePort(service, {})).toBe(DEFAULT_SERVICE_PORTS[service])
    }
  })

  test("a real override value is honored exactly", () => {
    expect(resolveServicePort("orchestrator", { [SERVICE_PORT_ENV_VARS.orchestrator]: "5000" })).toBe(5000)
  })

  test("empty string falls back to the default", () => {
    expect(resolveServicePort("orchestrator", { [SERVICE_PORT_ENV_VARS.orchestrator]: "" })).toBe(3000)
  })

  test("a non-numeric value falls back to the default rather than throwing", () => {
    expect(resolveServicePort("orchestrator", { [SERVICE_PORT_ENV_VARS.orchestrator]: "not-a-port" })).toBe(3000)
  })

  test("an out-of-range port value falls back to the default", () => {
    expect(resolveServicePort("orchestrator", { [SERVICE_PORT_ENV_VARS.orchestrator]: "0" })).toBe(3000)
    expect(resolveServicePort("orchestrator", { [SERVICE_PORT_ENV_VARS.orchestrator]: "70000" })).toBe(3000)
  })

  test("each service reads only its own env var, never a sibling's", () => {
    const env = { [SERVICE_PORT_ENV_VARS.devops]: "9999" }
    expect(resolveServicePort("devops", env)).toBe(9999)
    expect(resolveServicePort("orchestrator", env)).toBe(DEFAULT_SERVICE_PORTS.orchestrator)
  })
})
