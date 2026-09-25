import { describe, expect, test } from "bun:test"
import { normalizePastedText, MAX_PASTE_LENGTH } from "./paste-text"

describe("normalizePastedText", () => {
  test("plain text passes through unchanged", () => {
    expect(normalizePastedText("hello world", { singleLine: true })).toEqual({ ok: true, text: "hello world" })
  })

  test("CRLF and lone CR are normalized to LF", () => {
    expect(normalizePastedText("a\r\nb\rc", { singleLine: false })).toEqual({ ok: true, text: "a\nb\nc" })
  })

  test("single-line strips embedded newlines after normalization", () => {
    expect(normalizePastedText("line one\r\nline two", { singleLine: true })).toEqual({ ok: true, text: "line oneline two" })
  })

  test("multi-line preserves embedded newlines", () => {
    expect(normalizePastedText("line one\nline two", { singleLine: false })).toEqual({ ok: true, text: "line one\nline two" })
  })

  test("every C0 control character except newline is stripped — a pasted payload can never inject a keybinding-equivalent byte", () => {
    const withControls = `a\x03b\x1bc\x09d\x7fe` // Ctrl+C, Escape, Tab, DEL
    expect(normalizePastedText(withControls, { singleLine: false })).toEqual({ ok: true, text: "abcde" })
  })

  test("a pasted Ctrl+C byte does not survive into a single-line field either", () => {
    expect(normalizePastedText("path\x03/injected", { singleLine: true })).toEqual({ ok: true, text: "path/injected" })
  })

  test("real-world paste: a Windows path with spaces, unaffected", () => {
    const path = "C:\\Users\\moham\\My Project\\src"
    expect(normalizePastedText(path, { singleLine: true })).toEqual({ ok: true, text: path })
  })

  test("content at exactly the max length is accepted", () => {
    const text = "a".repeat(MAX_PASTE_LENGTH)
    const result = normalizePastedText(text, { singleLine: true })
    expect(result.ok).toBe(true)
  })

  test("content over the max length is rejected, never silently truncated", () => {
    const text = "a".repeat(MAX_PASTE_LENGTH + 1)
    const result = normalizePastedText(text, { singleLine: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("exceeding the maximum")
  })

  test("a custom maxLength is honored", () => {
    expect(normalizePastedText("hello", { singleLine: true, maxLength: 3 }).ok).toBe(false)
    expect(normalizePastedText("hi", { singleLine: true, maxLength: 3 }).ok).toBe(true)
  })

  test("length bound is checked AFTER stripping — control-byte noise doesn't count against the limit", () => {
    const text = "\x03".repeat(1000) + "a".repeat(MAX_PASTE_LENGTH)
    const result = normalizePastedText(text, { singleLine: true })
    expect(result.ok).toBe(true)
  })
})
