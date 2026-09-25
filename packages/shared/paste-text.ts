// specs/059-tui-bracketed-paste-support/spec.md — Phase 2.
//
// One shared pure helper for every in-scope hand-rolled text field
// (apps/supervisor/init-form.tsx's target-path/model-name fields) and
// the masked API-key reader (apps/supervisor/init-wizard.ts's
// promptLine()). The two OpenTUI-native fields (the TUI's chat input
// and new-task composer, both real @opentui/core <input> components)
// need no code here at all — their own handlePaste() already calls
// @opentui/core's decodePasteBytes()/stripAnsiSequences() internally
// (confirmed by reading the installed package directly), so this
// module exists only for the surfaces that manage their own buffer.

export const MAX_PASTE_LENGTH = 10_000

export type NormalizedPaste =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * Normalizes already-decoded pasted text (a plain string — the caller is
 * responsible for decodePasteBytes()/UTF-8 decoding first) for insertion
 * into a hand-rolled field's buffer:
 *   - line endings normalized (\r\n, \r -> \n);
 *   - every C0 control character except \n stripped (0x00-0x09, 0x0B-0x1F,
 *     0x7F) — a pasted payload must never be able to inject a
 *     keybinding-equivalent byte (Tab, Ctrl+C, Escape, ...) once it
 *     reaches a buffer as "just text," matching specs/050's own
 *     printable-vs-control precedent for a single keystroke;
 *   - single-line fields additionally strip \n itself (matching
 *     @opentui/core's own built-in single-line <input> paste handling);
 *   - bounded: content over maxLength is REJECTED, never silently
 *     truncated — a silently truncated path or key is a worse failure
 *     than a rejected paste.
 */
export function normalizePastedText(
  raw: string,
  options: { singleLine: boolean; maxLength?: number },
): NormalizedPaste {
  const maxLength = options.maxLength ?? MAX_PASTE_LENGTH

  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  // eslint-disable-next-line no-control-regex -- deliberately matching C0 control bytes
  text = text.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
  if (options.singleLine) text = text.replace(/\n/g, "")

  if (text.length > maxLength) {
    return {
      ok: false,
      error: `Pasted content is ${text.length} characters, exceeding the maximum of ${maxLength} — rejected, not truncated.`,
    }
  }
  return { ok: true, text }
}
