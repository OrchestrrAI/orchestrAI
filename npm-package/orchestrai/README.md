# orchestrai

![OrchestrAI](https://unpkg.com/orchestrai@latest/logo.png)

Run OrchestrAI — a local, terminal-oriented multi-agent DevOps orchestration prototype — with nothing pre-installed. No Bun, no clone, no separate download step: the right platform binary installs automatically as part of this package (an optional dependency scoped to your OS/architecture).

## Install

```
npm install -g orchestrai@latest
```

(pin a specific version instead of `@latest` any time you want a reproducible install — see [Reproducibility](#reproducibility) below.)

## Set up your project, once

```
orchestrai init
```

Walks you through the target project path, which of the 4 agents to run, each selected agent's own optional LLM harness, and a required LLM provider/model/API key (the orchestrator's own adaptive planner needs one to start at all). Answer once — it's saved per project, in a `.orchestrai/` folder next to where you run it.

## Run it

```
orchestrai
```

Starts the full local stack — 4 specialist agents (DevOps, testing, documentation, security), an MCP tool server, and an orchestrator that routes work between them (including its own adaptive planner — it needs an LLM provider key configured to start) — then opens a **dashboard at [http://localhost:3000/dashboard](http://localhost:3000/dashboard)**. That's where you submit tasks and watch them run. In a real terminal it also opens an interactive terminal viewer alongside the dashboard.

## Prefer a one-shot run instead?

```
npx orchestrai@latest --project /path/to/your/project
```

or, with Bun:

```
bunx orchestrai@latest --project /path/to/your/project
```

Skips the global install and the saved per-project setup — useful for a quick one-off run, but `init` is the better path if you'll run it against the same project more than once.

## Supported platforms

| Platform | Package |
|---|---|
| Windows x64 | `orchestrai-windows-x64` |
| Linux x64 | `orchestrai-linux-x64` |
| macOS Apple Silicon (arm64) | `orchestrai-darwin-arm64` |

macOS Intel (x64) isn't published yet. If `npx`/`bunx` reports no build for your platform, that's why.

### macOS: unsigned binary

The macOS build isn't code-signed or notarized. On first run, macOS Gatekeeper will likely refuse to open it. Clear that with:

```
xattr -d com.apple.quarantine "$(which orchestrai)"
```

(or the equivalent path npm installed it under) before running it again.

## All flags

```
orchestrai                          # start everything, interactively in a real terminal
orchestrai init                     # interactive setup wizard, run once per project
orchestrai --project "/path/to/app" # override the saved/inferred target path for this run
orchestrai --only devops-agent      # start a subset of services (comma-separated)
orchestrai --headless               # backend only, plain logs — no interactive viewer
orchestrai --help
```

## Reproducibility

Each published version of this package corresponds to a specific, immutable build. Pin a version instead of `@latest` any time you want that guarantee:

```
npm install -g orchestrai@0.1.12
```

or for the one-shot form:

```
npx orchestrai@0.1.12 --project /path/to/your/project
```

Either always resolves the identical binary, not a rolling "latest."

## Source

The source repository is currently private, so it isn't publicly browsable — everything you need to actually run this is in this package itself (`orchestrai --help` and `orchestrai init` cover it). This README will link out to public docs if/when that changes.
