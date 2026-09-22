/**
 * The character class `displaySafe` maps to a space, spelled by CODE POINT.
 *
 * Shared by the `*-display-safe.test.ts` files so each one pins the same class
 * (issue go-to-k/cdkd#3479). Spelled here by NUMBER rather than imported from
 * `src/utils/display-safe.ts`: an assertion that reuses the subject's own
 * pattern is satisfied by a subject whose pattern changed underneath it.
 *
 * Every member is a real forging mechanism, not a tidiness rule:
 *
 * - C0 + DEL and the C1 range — a UTF-8 xterm reads `U+009B` as CSI, so
 *   `U+009B` `2 K` erases the line cdkd just printed, and `U+0085` (NEL) starts
 *   a new one;
 * - `U+2028` / `U+2029` — line terminators to JSON and to web log viewers,
 *   which re-render this text after cdkd has persisted it;
 * - `U+202A`-`U+202E` / `U+2066`-`U+2069` — the Trojan-Source bidi overrides and
 *   isolates, which visually REORDER a rendered command.
 *
 * Constructed with `String.fromCharCode` rather than written as `\uXXXX`
 * escapes because a raw `U+2028` inside a source-level regex literal terminates
 * it, and a numeric spelling cannot be mistaken for the sanitized twin beside
 * it in a diff.
 */

const FORGING_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/** Does `text` still carry anything `displaySafe` is supposed to have removed? */
export function hasForgingCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (FORGING_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

/** ESC — the first byte of the 7-bit `ESC [ 2 K` erase-line sequence. */
export const ESC = String.fromCharCode(0x1b);
/** C1 CSI — the 8-bit form of the same sequence's introducer. */
export const CSI = String.fromCharCode(0x9b);
/** C1 OSC terminator, a second distinguishable C1 byte. */
export const ST = String.fromCharCode(0x9d);
/** NEL — a C1 line terminator. */
export const NEL = String.fromCharCode(0x85);
/** LINE SEPARATOR — a line terminator to JSON and to web log viewers. */
export const LINE_SEP = String.fromCharCode(0x2028);
/** PARAGRAPH SEPARATOR — the sibling of {@link LINE_SEP}. */
export const PARA_SEP = String.fromCharCode(0x2029);
/** RIGHT-TO-LEFT OVERRIDE — Trojan Source. */
export const RLO = String.fromCharCode(0x202e);
/** LEFT-TO-RIGHT ISOLATE — Trojan Source. */
export const LRI = String.fromCharCode(0x2066);

/**
 * ZERO WIDTH SPACE — the recorded RESIDUAL of `displaySafe`'s denylist, which
 * its `asciiOnly` allowlist does remove. Not in {@link hasForgingCharacter}'s
 * class, deliberately: it cannot forge a line, only make a rendered value
 * differ visually from its bytes. It is here so a case can tell the two MODES
 * apart, which no forging character can.
 */
export const ZWSP = String.fromCharCode(0x200b);
