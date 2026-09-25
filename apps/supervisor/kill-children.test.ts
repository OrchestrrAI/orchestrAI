// specs/067-supervisor-kill-orphaned-children-on-exit/spec.md
//
// The portable, unit-testable part: the synchronous exit backstop hard-
// kills every tracked child and never throws, even when a child's own
// kill() throws (already exited / stale handle). The window-close and
// supervisor-kill scenarios themselves need a live real terminal — see
// this spec's Verification Plan.
import { describe, expect, test } from "bun:test"
import { killAllChildrenSync, runExitBackstop } from "./index"

describe("killAllChildrenSync — specs/067", () => {
  test("calls kill('SIGKILL') on every child in the list", () => {
    const killed: string[] = []
    const fakes = [
      { proc: { kill: (sig?: string) => killed.push(`a:${sig}`) } },
      { proc: { kill: (sig?: string) => killed.push(`b:${sig}`) } },
      { proc: { kill: (sig?: string) => killed.push(`c:${sig}`) } },
    ]
    killAllChildrenSync(fakes as unknown as Parameters<typeof killAllChildrenSync>[0])
    expect(killed).toEqual(["a:SIGKILL", "b:SIGKILL", "c:SIGKILL"])
  })

  test("a child whose kill() throws does not stop the sweep or propagate", () => {
    const killed: string[] = []
    const fakes = [
      { proc: { kill: () => killed.push("first") } },
      { proc: { kill: () => { throw new Error("ESRCH — already gone") } } },
      { proc: { kill: () => killed.push("third") } },
    ]
    expect(() => killAllChildrenSync(fakes as unknown as Parameters<typeof killAllChildrenSync>[0])).not.toThrow()
    expect(killed).toEqual(["first", "third"]) // the throwing one didn't block the last
  })

  test("an empty list is a no-op", () => {
    expect(() => killAllChildrenSync([] as Parameters<typeof killAllChildrenSync>[0])).not.toThrow()
  })
})

// specs/074-fix-exit-backstop-argument-bug/spec.md — reproduces the real
// bug directly, not just killAllChildrenSync's own already-correct
// explicit-list behavior above: Node/Bun always calls a process "exit"
// listener WITH the exit code (`listener(code)`), never with zero
// arguments. Registering killAllChildrenSync itself as that listener let
// that code silently override its own `list = children` default,
// crashing `for (const c of list)` on every real exit. runExitBackstop
// is the actual registered listener; simulating Node's real call shape
// against it (an explicit numeric argument) is what proves the fix,
// where calling killAllChildrenSync with no arguments at all never would
// have caught this in the first place.
describe("runExitBackstop — specs/074", () => {
  test("does not throw when called with an exit code, the way Node's own \"exit\" event always calls it", () => {
    expect(() => runExitBackstop(0)).not.toThrow()
    expect(() => runExitBackstop(1)).not.toThrow()
  })
})
