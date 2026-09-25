# Implementation Plan: AG-UI Demo and TUI Stabilization

This plan extracts the implementation sequence approved in `spec.md` by
Yusuf on 2026-08-16. Implementation is authorized only within that scope.

## Preconditions

- Yusuf explicitly approves `spec.md`, including its open review decisions.
- The numbered-folder governance migration is complete and green.

## Proposed Phases

1. Make TUI event handling renderer-safe by removing ordinary terminal logging
   from render/stream paths while preserving bounded reconnect behavior.
2. Track and render bounded plan-step state in existing TUI surfaces.
3. Replace the Bash-only demo with the proposed cross-platform Bun runner and
   preserve non-mutating defaults.
4. Add focused AG-UI correlation/state tests.
5. Run default and explicitly write-enabled live demo scenarios.
6. Update AG-UI/TUI command documentation, runbook, and final worklog evidence.

## Expected Paths

- `apps/tui/`
- `apps/orchestrator/`
- `packages/shared/`
- `scripts/`
- `context/demo/`
- `README.md`
- this feature folder

## Safety Boundary

- Default demo mode remains non-mutating.
- Approval authorization remains the existing server-issued `actionId` flow.
- This plan cannot introduce official SDK/framework adoption without a revised
  and re-approved `spec.md`.
