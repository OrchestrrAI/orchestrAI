---
description: Run the verification gates for a spec and draft its verification.md (GLM-flash) — e.g. /verify 118
agent: verifier
---

Verify spec $1: run the gates (`bun test`, `bun run typecheck`,
`bun run specs:check`) and capture their real output, then draft
`specs/$1-*/verification.md` from the actual evidence — commands, dates,
results, and what remains unverified. Style it after the existing
`verification.md` files under `specs/`. Never change any spec's frontmatter.
