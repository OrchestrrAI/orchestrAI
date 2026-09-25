// specs/044-conversational-ask-layer/spec.md — Phase 2, deterministic half.
//
// Both fixtures below are REAL captured output, not hand-written
// approximations of the format:
//   - BUN_REAL: `bun test --coverage` (Bun 1.3.14) on a scratch project
//   - PYTEST_REAL: `python -m pytest --cov` (pytest 9.1.1, pytest-cov
//     7.1.0) in a disposable venv
// Writing these patterns against assumed formats is exactly how a parser
// ends up silently returning null in production, so they were captured
// from the real runners first and pasted here verbatim.
import { describe, expect, test } from "bun:test"
import { parseCoveragePercent, parseTestCounts } from "./test-runner"

const BUN_REAL = `------------------|---------|---------|-------------------
File              | % Funcs | % Lines | Uncovered Line #s
------------------|---------|---------|-------------------
All files         |   75.00 |  100.00 |
 src\\math.test.ts |  100.00 |  100.00 |
 src\\math.ts      |   50.00 |  100.00 |
------------------|---------|---------|-------------------

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [47.00ms]`

const PYTEST_REAL = `============================= test session starts =============================
platform win32 -- Python 3.12.10, pytest-9.1.1, pluggy-1.6.0
collected 1 item

test_calc.py .                                                           [100%]

=============================== tests coverage ================================
______________ coverage: platform win32, python 3.12.10-final-0 _______________

Name           Stmts   Miss  Cover
----------------------------------
calc.py            4      1    75%
test_calc.py       3      0   100%
----------------------------------
TOTAL              7      1    86%
============================== 1 passed in 0.24s ==============================`

describe("parseCoveragePercent — against real captured runner output", () => {
  test("extracts bun's line coverage from the All files row", () => {
    expect(parseCoveragePercent(BUN_REAL)).toBe(100)
  })

  test("takes bun's % Lines column, not the % Funcs column beside it", () => {
    // The real fixture has 75.00 funcs / 100.00 lines — a parser grabbing
    // the first number would silently report the wrong metric.
    expect(parseCoveragePercent(BUN_REAL)).not.toBe(75)
  })

  test("extracts pytest's TOTAL percentage", () => {
    expect(parseCoveragePercent(PYTEST_REAL)).toBe(86)
  })

  test("takes pytest's TOTAL row, not an individual file's row", () => {
    // calc.py shows 75% and test_calc.py 100% — only TOTAL is the answer.
    expect(parseCoveragePercent(PYTEST_REAL)).not.toBe(75)
    expect(parseCoveragePercent(PYTEST_REAL)).not.toBe(100)
  })

  test("handles a fractional percentage", () => {
    expect(parseCoveragePercent("All files         |   75.00 |   82.35 |")).toBe(82.35)
    expect(parseCoveragePercent("TOTAL              7      1    82.35%")).toBe(82.35)
  })

  test("returns null — never 0 — when no coverage was reported", () => {
    // A plain non-coverage run must read as "absent", not "zero percent".
    expect(parseCoveragePercent("1 pass\n0 fail\nRan 1 test across 1 file.")).toBeNull()
    expect(parseCoveragePercent("")).toBeNull()
  })

  test("does not mistake unrelated percentages for coverage", () => {
    // pytest's own progress column prints [100%] on every run.
    expect(parseCoveragePercent("test_calc.py .    [100%]\n1 passed in 0.24s")).toBeNull()
  })
})

describe("parseTestCounts still works on the same real output — unchanged by specs/044", () => {
  test("bun", () => {
    expect(parseTestCounts(BUN_REAL)).toEqual({ passed: 1, failed: 0 })
  })

  test("pytest", () => {
    expect(parseTestCounts(PYTEST_REAL)).toEqual({ passed: 1, failed: 0 })
  })
})
