// specs/108-durable-audit-trail/spec.md B7 — the dashboard Audit tab,
// asserted against the real generated HTML in-process (app.fetch(), no
// port bound) — the same technique specs/035/040/044 already established
// for these inline dashboards, since a real browser click-through isn't
// available in this environment.
import { describe, expect, test } from "bun:test"
import { app } from "./index"

describe("dashboard Audit tab", () => {
  test("the rendered dashboard contains the Audit tab, its panel, and the GET /audit fetch call", async () => {
    const res = await app.request("/dashboard")
    expect(res.status).toBe(200)
    const html = await res.text()

    // The tab itself, wired into the same tablist/hash-routing every
    // other tab already uses.
    expect(html).toContain('id="tab-audit"')
    expect(html).toContain('id="panel-audit"')
    expect(html).toContain("navigateTo('audit')")

    // Its own filter + table + the real fetch it makes.
    expect(html).toContain('id="auditTaskFilter"')
    expect(html).toContain('id="auditRows"')
    expect(html).toContain("loadAuditEvents()")
    expect(html).toContain("'/audit")

    // VIEW_NAMES itself includes the new tab — confirms hash routing
    // (#audit) and arrow-key tab navigation both reach it generically,
    // not just that the markup happens to exist.
    expect(html).toContain("['chat', 'tasks', 'agents', 'audit']")
  })

  test("the Audit tab is read-only — no write/mutation call anywhere in its own markup", async () => {
    const html = await (await app.request("/dashboard")).text()
    const auditPanelMatch = html.match(/<section id="panel-audit"[\s\S]*?<\/section>/)
    expect(auditPanelMatch).not.toBeNull()
    const auditPanelHtml = auditPanelMatch![0]
    // No POST/PUT/DELETE-shaped call, no approve/reject/skip action,
    // anywhere inside this one panel's own markup.
    expect(auditPanelHtml).not.toMatch(/method:\s*['"]POST['"]/)
    expect(auditPanelHtml).not.toContain("approve(")
    expect(auditPanelHtml).not.toContain("reject(")
  })
})
