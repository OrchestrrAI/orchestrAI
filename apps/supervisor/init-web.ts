// specs/049-guided-init-web-setup/spec.md
//
// The browser half of guided init — the terminal half is init-form.tsx
// (specs/048). Both write through the exact same config contract
// (formStateToWizardConfig/writeWizardConfig/validate, all from
// init-form-state.ts/init-wizard.ts, unmodified) — this file is a new
// INPUT method, never a second definition of what a valid config is.
//
// This is the only inbound HTTP surface in this repo that accepts a
// secret from a browser. Every item in the spec's own "Security model"
// section is load-bearing, not boilerplate:
//   - loopback only (127.0.0.1, never 0.0.0.0);
//   - an ephemeral, OS-chosen port, never fixed;
//   - an unguessable, >=128-bit per-run token embedded in the URL path;
//   - Origin AND Host both required and checked against this exact
//     run's own loopback address/port;
//   - single-use — the token stops working after the first successful
//     submit;
//   - bounded lifetime — shuts down on submit, Ctrl+C, or a 10-minute
//     timeout, never lingers;
//   - the key is never echoed anywhere (response, redirect, log, error).
import { Hono } from "hono"
import { existsSync, statSync } from "fs"
import { AGENT_CATALOG, skillHint } from "./agent-catalog"
import {
  LLM_PROVIDERS,
  maskKey,
  readExistingWizardConfig,
  writeWizardConfig,
  type LlmProvider,
  type WizardConfig,
} from "./init-wizard"
import { LLM_COMPONENTS } from "../../packages/shared/llm-model-factory"
import {
  formStateToWizardConfig,
  initialFormState,
  validate,
  type InitFormState,
  type InitOutcome,
} from "./init-form-state"

// ============================================================
// TOKEN
// ============================================================
// crypto.randomUUID() gives ~122 bits of real randomness (6 bits are
// fixed by the UUID v4 format) — under the spec's own stated >=128-bit
// floor. Using getRandomValues() directly over a 24-byte (192-bit)
// buffer avoids that ambiguity entirely rather than relying on a UUID's
// incidental shape.
export function generateToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Constant-time-ish comparison — this is a local, single-run, low-value
 *  timing surface (an attacker would need local code execution already,
 *  at which point far easier attacks exist), but the token is the one
 *  thing standing between "loopback" and "actually private," so this
 *  costs nothing and removes the question entirely. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ============================================================
// ORIGIN/HOST ENFORCEMENT
// ============================================================
export function isRequestFromExpectedOrigin(headers: { origin: string | null; host: string | null }, port: number): boolean {
  const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  if (!headers.host || !expectedHosts.has(headers.host)) return false
  // Required, not merely checked-if-present: a same-origin fetch() call
  // from the page's own script always carries a real Origin header in
  // every real browser for a state-changing method — its absence here is
  // treated as suspicious, never assumed same-origin by omission.
  const expectedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  if (!headers.origin || !expectedOrigins.has(headers.origin)) return false
  return true
}

// ============================================================
// SUBMISSION PARSING — the browser's JSON body -> the exact same
// InitFormState shape specs/048's TUI form already produces, so
// formStateToWizardConfig()/validate() run completely unmodified.
// ============================================================
export interface InitWebSubmissionBody {
  targetPath?: unknown
  selectedAgents?: unknown
  agentLlm?: unknown
  llmProvider?: unknown
  llmModel?: unknown
  llmApiKey?: unknown
  modelOverrides?: unknown
}

export type ParsedSubmission = { ok: true; state: InitFormState } | { ok: false; error: string }

/** Builds a full InitFormState from the browser's submitted answers, on
 *  top of the same initialFormState() baseline the TUI form and this
 *  page's own GET both render from — the UI-only fields (view/focus/
 *  modelCursor/agentCursor) never mattered to formStateToWizardConfig()
 *  in the first place and are left at their harmless defaults. */
export function parseSubmission(body: unknown, base: InitFormState): ParsedSubmission {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Request body must be a JSON object" }
  const b = body as InitWebSubmissionBody

  if (typeof b.targetPath !== "string") return { ok: false, error: "'targetPath' must be a string" }
  if (b.selectedAgents !== undefined && !Array.isArray(b.selectedAgents)) return { ok: false, error: "'selectedAgents' must be an array" }
  const selectedAgents = Array.isArray(b.selectedAgents) ? b.selectedAgents.filter((a): a is string => typeof a === "string" && base.allAgents.includes(a)) : base.allAgents

  // specs/070 — the browser form no longer has per-agent LLM toggles;
  // selecting an agent IS the decision, and formStateToWizardConfig()
  // derives the ORCHESTRAI_<AGENT>_LLM_HARNESS=1 lines from the selection.
  // An `agentLlm` key in the body (from an old cached page) is ignored.

  if (b.llmProvider !== undefined && !LLM_PROVIDERS.includes(b.llmProvider as LlmProvider)) {
    return { ok: false, error: `'llmProvider' must be one of: ${LLM_PROVIDERS.join(", ")}` }
  }
  const llmProvider = (b.llmProvider as LlmProvider | undefined) ?? base.llmProvider

  if (b.llmModel !== undefined && typeof b.llmModel !== "string") return { ok: false, error: "'llmModel' must be a string" }
  if (b.llmApiKey !== undefined && typeof b.llmApiKey !== "string") return { ok: false, error: "'llmApiKey' must be a string" }

  const modelOverrides = { ...base.modelOverrides }
  if (b.modelOverrides !== undefined) {
    if (typeof b.modelOverrides !== "object" || b.modelOverrides === null) return { ok: false, error: "'modelOverrides' must be an object" }
    for (const component of LLM_COMPONENTS) {
      const value = (b.modelOverrides as Record<string, unknown>)[component]
      if (typeof value === "string") modelOverrides[component] = value
    }
  }

  const state: InitFormState = {
    ...base,
    targetPath: b.targetPath,
    selectedAgents,
    llmProvider,
    llmModel: typeof b.llmModel === "string" ? b.llmModel : base.llmModel,
    llmApiKey: typeof b.llmApiKey === "string" ? b.llmApiKey : base.llmApiKey,
    modelOverrides,
  }
  return { ok: true, state }
}

// ============================================================
// PAGE — self-contained, no CDN, no build step, no framework, no
// outbound request of any kind (no external font/script/stylesheet —
// deliberately NOT the Google Fonts link every dashboard-adjacent page
// in this repo could otherwise reach for; this one page must be fully
// offline, per the spec's own security model).
// ============================================================
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function buildPageHtml(base: InitFormState, token: string): string {
  const agentRows = AGENT_CATALOG.map((a) => {
    const checked = base.selectedAgents.includes(a.name) ? "checked" : ""
    return `<label class="agent-row"><input type="checkbox" name="agent" value="${escapeHtml(a.name)}" ${checked}> <span class="agent-name">${escapeHtml(a.name)}</span> <span class="agent-skills">${escapeHtml(skillHint(a.name))}</span></label>`
  }).join("\n")

  // specs/070 — no per-agent LLM harness section; selecting an agent is
  // the whole decision, mirrored from the TUI form.
  const providerOptions = LLM_PROVIDERS.map((p) => `<option value="${p}" ${p === base.llmProvider ? "selected" : ""}>${p}</option>`).join("")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrchestrAI Setup</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0d1117; color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.6; padding: 32px 16px 64px;
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { color: #f0f6fc; font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8b949e; margin: 0 0 24px; font-size: 13px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  label.field-label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  input[type=text], input[type=password], select {
    width: 100%; padding: 8px 10px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 4px; color: #c9d1d9; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px;
  }
  input:focus, select:focus { border-color: #58a6ff; outline: none; }
  .field { margin-bottom: 14px; }
  .error { color: #f85149; font-size: 12px; margin-top: 4px; min-height: 1em; }
  .agent-row, .toggle-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
  .agent-name { color: #58a6ff; font-weight: 600; }
  .agent-skills { color: #6e7681; font-size: 11px; }
  .key-row { display: flex; gap: 8px; align-items: center; }
  .key-row input { flex: 1; }
  button.show-hide { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; border-radius: 4px; padding: 8px 12px; cursor: pointer; font-size: 12px; }
  .warning { background: #2e2716; border: 1px solid #d29922; color: #e3b341; border-radius: 6px; padding: 10px 12px; font-size: 12.5px; margin-top: 10px; }
  .review { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: #8b949e; white-space: pre-wrap; }
  button.submit {
    background: #238636; border: 1px solid #2ea043; color: #fff; border-radius: 6px;
    padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%;
  }
  button.submit:disabled { background: #21262d; border-color: #30363d; color: #6e7681; cursor: not-allowed; }
  #status { margin-top: 16px; font-size: 13px; }
  #status.ok { color: #3fb950; }
  #status.err { color: #f85149; }
  .done { text-align: center; padding: 40px 20px; }
  .done h2 { color: #3fb950; }
</style>
</head>
<body>
<div class="wrap">
  <div id="form-view">
    <h1>OrchestrAI Setup</h1>
    <p class="sub">Configure this project. Nothing is written until you submit. Return to the terminal once you see the confirmation below.</p>

    <div class="card">
      <div class="field">
        <label class="field-label" for="targetPath">Target project</label>
        <input type="text" id="targetPath" value="${escapeHtml(base.targetPath)}">
        <div class="error" id="targetPath-error"></div>
      </div>
    </div>

    <div class="card">
      <label class="field-label">Agents</label>
      <p class="agent-skills">A selected agent runs its LLM path automatically.</p>
      ${agentRows}
    </div>

    <div class="card">
      <div class="field">
        <label class="field-label" for="llmProvider">Provider</label>
        <select id="llmProvider">${providerOptions}</select>
      </div>
      <div class="field">
        <label class="field-label" for="llmModel">Model (optional unless gemini)</label>
        <input type="text" id="llmModel" value="${escapeHtml(base.llmModel)}">
        <div class="error" id="llmModel-error"></div>
      </div>
      <div class="field">
        <label class="field-label" for="llmApiKey">API key</label>
        <div class="key-row">
          <input type="password" id="llmApiKey" autocomplete="off">
          <button type="button" class="show-hide" id="toggle-key">Show</button>
        </div>
        <div class="warning">⚠ The API key will be stored in plaintext in .orchestrai/config.env on this machine.</div>
      </div>
    </div>

    <button class="submit" id="submit-btn">Save</button>
    <div id="status"></div>
  </div>

  <div id="done-view" style="display:none" class="done">
    <h2>Saved.</h2>
    <p>Return to the terminal and run "orchestrai" (no flags) to use this configuration.</p>
    <p class="review" id="done-summary"></p>
  </div>
</div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};

  function collect() {
    var selectedAgents = Array.prototype.slice.call(document.querySelectorAll('input[name=agent]:checked')).map(function (el) { return el.value; });
    return {
      targetPath: document.getElementById('targetPath').value,
      selectedAgents: selectedAgents,
      llmProvider: document.getElementById('llmProvider').value,
      llmModel: document.getElementById('llmModel').value,
      llmApiKey: document.getElementById('llmApiKey').value,
      modelOverrides: {}
    };
  }

  document.getElementById('toggle-key').addEventListener('click', function () {
    var el = document.getElementById('llmApiKey');
    var showing = el.type === 'text';
    el.type = showing ? 'password' : 'text';
    this.textContent = showing ? 'Show' : 'Hide';
  });

  document.getElementById('submit-btn').addEventListener('click', function () {
    var btn = this;
    var status = document.getElementById('status');
    btn.disabled = true;
    status.className = '';
    status.textContent = 'Saving…';
    fetch('/s/' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect())
    }).then(function (res) {
      return res.json().then(function (data) { return { status: res.status, data: data }; });
    }).then(function (result) {
      if (result.status !== 200) {
        btn.disabled = false;
        status.className = 'err';
        status.textContent = result.data.error || 'Could not save — check the fields above.';
        document.getElementById('targetPath-error').textContent = (result.data.fieldErrors || {}).targetPath || '';
        document.getElementById('llmModel-error').textContent = (result.data.fieldErrors || {}).llmModel || '';
        return;
      }
      document.getElementById('form-view').style.display = 'none';
      document.getElementById('done-view').style.display = 'block';
      document.getElementById('done-summary').textContent = 'Project: ' + result.data.targetPath + '\\nAPI key: ' + result.data.maskedKey;
    }).catch(function () {
      btn.disabled = false;
      status.className = 'err';
      status.textContent = 'Could not reach the setup server — is it still running?';
    });
  });
})();
</script>
</body>
</html>`
}

// ============================================================
// APP
// ============================================================
export interface InitWebAppOptions {
  token: string
  port: number
  base: InitFormState
  /** Called exactly once, on the first valid submission — writes the
   *  config and signals the caller to shut the server down. Never called
   *  again after (single-use, enforced by the app itself, not by the
   *  caller trusting this to only fire once). specs/122 — this no longer
   *  leads into launching the stack; see runInitWebAndWrite's own comment. */
  onSubmit: (config: WizardConfig) => void
}

export interface InitWebApp {
  app: Hono
  /** True once a submission has succeeded — every request after this,
   *  including a repeat GET of the page, 404s. */
  isUsed: () => boolean
}

export function createInitWebApp(options: InitWebAppOptions): InitWebApp {
  const { token, port, base, onSubmit } = options
  let used = false
  const app = new Hono()

  app.get("/s/:token", (c) => {
    if (used || !tokensMatch(c.req.param("token"), token)) return c.notFound()
    return c.html(buildPageHtml(base, token))
  })

  app.post("/s/:token/check-path", async (c) => {
    if (used || !tokensMatch(c.req.param("token"), token)) return c.notFound()
    if (!isRequestFromExpectedOrigin({ origin: c.req.header("origin") ?? null, host: c.req.header("host") ?? null }, port)) {
      return c.notFound()
    }
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: "Malformed JSON body" }, 400) }
    const target = typeof body === "object" && body !== null ? (body as { path?: unknown }).path : undefined
    if (typeof target !== "string") return c.json({ error: "'path' must be a string" }, 400)
    const exists = existsSync(target) && statSync(target).isDirectory()
    return c.json({ exists })
  })

  app.post("/s/:token", async (c) => {
    if (used || !tokensMatch(c.req.param("token"), token)) return c.notFound()
    if (!isRequestFromExpectedOrigin({ origin: c.req.header("origin") ?? null, host: c.req.header("host") ?? null }, port)) {
      return c.notFound()
    }

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: "Malformed JSON body" }, 400) }

    const parsed = parseSubmission(body, base)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const dirExists = (p: string) => existsSync(p) && statSync(p).isDirectory()
    const validation = validate(parsed.state, dirExists)
    if (!validation.canSave) {
      return c.json({ error: "Invalid configuration.", fieldErrors: validation.errors }, 400)
    }

    // Single-use: marked BEFORE calling out, so a slow/duplicate request
    // racing this one can never both pass — the second one's own
    // `used` check above (evaluated at the top of this same handler,
    // synchronously, before any await here) already lost the race.
    used = true
    const config = formStateToWizardConfig(parsed.state)
    onSubmit(config)

    return c.json({
      targetPath: config.projectPath,
      maskedKey: config.llmApiKey ? maskKey() : "not set",
    })
  })

  app.notFound((c) => c.text("Not found", 404))

  return { app, isUsed: () => used }
}

// ============================================================
// ORCHESTRATION — real Bun.serve(), browser auto-open, timeout,
// Ctrl+C. Mirrors runInitFormAndWrite()'s own shape (specs/048) exactly
// so dispatch() in index.ts can treat both the same way.
// ============================================================
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") Bun.spawn(["cmd", "/c", "start", "", url], { stdio: ["ignore", "ignore", "ignore"] })
    else if (process.platform === "darwin") Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] })
    else Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] })
  } catch {
    // No browser available (SSH, headless, WSL without a handler) — the
    // URL is already printed; the caller keeps waiting regardless.
  }
}

/** specs/122 — always resolves "saved", never "started": this used to be
 *  the browser form's only outcome and unconditionally launched the stack
 *  in the same process afterward (dispatch()'s now-removed chdir+main()
 *  chain), which was a confirmed crash/hang on a real terminal. The
 *  browser has no terminal session to hand off to anyway; saving and
 *  telling the user to run `orchestrai` separately was always the more
 *  honest behavior for this surface. */
export async function runInitWebAndWrite(targetDirDefault: string): Promise<InitOutcome> {
  const existing = readExistingWizardConfig(targetDirDefault)
  const allAgents = AGENT_CATALOG.map((a) => a.name)
  const base = initialFormState(targetDirDefault, allAgents, existing)
  const token = generateToken()

  return new Promise((resolve) => {
    let server: ReturnType<typeof Bun.serve> | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      process.off("SIGINT", onSigint)
      server?.stop(true)
    }

    const finish = (outcome: InitOutcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const onSigint = () => {
      console.log("\nCancelled — nothing was written.")
      finish({ outcome: "cancelled" })
    }
    process.on("SIGINT", onSigint)

    let capturedConfig: WizardConfig | null = null
    const { app } = createInitWebApp({
      token,
      // Placeholder — replaced with the real bound port right after
      // Bun.serve() resolves it below. The app closure reads `port` by
      // reference via this mutable box, not a captured primitive.
      port: 0,
      base,
      onSubmit: (config) => {
        capturedConfig = config
      },
    })

    // Bun.serve() with port 0 asks the OS for an ephemeral port — never
    // fixed, never configurable, matching the spec's own requirement.
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
    const port = server.port
    if (port === undefined) throw new Error("Bun.serve() did not report a bound port")
    // The app above closed over `port: 0` at construction time (before
    // the real port was known) only for the isRequestFromExpectedOrigin()
    // checks inside its own handlers — rebuild it now that the real port
    // exists, then swap Bun.serve()'s own fetch target. Simpler than
    // threading a mutable ref through Hono: one extra construction, at
    // the one place port truly becomes known.
    const real = createInitWebApp({
      token,
      port,
      base,
      onSubmit: (config) => {
        capturedConfig = config
      },
    })
    server.reload({ fetch: real.app.fetch })

    const url = `http://127.0.0.1:${port}/s/${token}`
    console.log(`\n  Setup page:  ${url}`)
    console.log(`  Opening your browser… (Ctrl+C cancels; nothing is written until you submit)\n`)
    openBrowser(url)

    timeoutHandle = setTimeout(() => {
      console.log("\nSetup timed out after 10 minutes of inactivity — nothing was written.")
      finish({ outcome: "cancelled" })
    }, INACTIVITY_TIMEOUT_MS)

    // Poll for the single-use flag flipping rather than plumbing a
    // resolver through Hono's own request/response cycle — the same
    // "poll the shared in-memory state" shape this codebase's other
    // terminal-state watchers already use (e.g. apps/orchestrator/
    // index.ts's appendAnswerWhenTaskTerminates()).
    const pollHandle = setInterval(() => {
      if (!capturedConfig) return
      clearInterval(pollHandle)
      const config = capturedConfig
      writeWizardConfig(config.projectPath, config)
      // specs/122 — always "saved", never "started": this used to
      // unconditionally launch the stack in the same process
      // (dispatch()'s now-removed chdir+main() chain), which was a
      // confirmed crash/hang on a real terminal, never a working path.
      console.log(`\nSaved. Run "orchestrai" (no flags) from ${config.projectPath} to use this configuration.`)
      finish({ outcome: "saved", targetPath: config.projectPath })
    }, 150)
  })
}
