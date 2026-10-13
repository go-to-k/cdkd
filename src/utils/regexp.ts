import { displaySafe } from './display-safe.js';

/**
 * Escape a literal string for embedding in a RegExp.
 *
 * Lives here because the same four-line helper was spelled THREE times — in
 * `src/utils/ecr-uri.ts`, `src/cli/commands/gc.ts` and
 * `src/assets/asset-redirect.ts` — each interpolating a user-controlled name
 * (an AWS region, a bootstrap-marker asset bucket / container repo, an ECR host
 * label) into a pattern. Copies of a security-shaped helper are exactly the
 * shape that drifts: the escaped set is what stops a `.` in an interpolated
 * literal matching ANY character, and in `gc.ts` a widened match decides which
 * live assets are treated as referenced.
 *
 * The character set is the union every JS engine treats as special in a
 * non-`u` pattern. `-` is deliberately absent: it is only special INSIDE a
 * character class, and no caller embeds into one.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove control characters from a value about to be PRINTED.
 *
 * Lives beside {@link escapeRegExp} for the reason that helper's own note
 * gives: this was spelled twice — in `src/cli/commands/diff-recursive.ts` and
 * in `src/deployment/outputs-export-alias.ts` — and copies of a
 * security-shaped helper drift. Both print the same class of string: a
 * resolved CloudFormation Output / `Export.Name`, which passed no CFn
 * validator, so it can carry ANSI escapes or bidi overrides straight into a
 * terminal or a CI log.
 *
 * C0 + DEL + C1 + the bidi marks and isolates. Apply on HUMAN-render paths
 * only: a `--json` payload is a machine interface where an export name is data
 * a consumer may match on, and mutating it there trades a correctness
 * regression for a display concern (see `stripDisplayOnlyChars`, which is the
 * narrower guard for an already-serialized payload and stays local to its
 * caller because its C0 exclusion is specific to that path).
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

/**
 * {@link stripControlChars} for a string a human-render path PRINTS on its own
 * line or inside cdkd's own sentence: the strip, then `displaySafe` around it
 * (go-to-k/cdkd#2888).
 *
 * The strip alone keeps `U+2028` / `U+2029`, which a JSON or web log viewer
 * reads as line terminators, so a printed name could still forge a row there.
 * `displaySafe` replaces both with a space and trims; on the strip's output
 * those two are all it still has to change, because every other character in
 * its class is already gone.
 *
 * It DELETES exactly the strip's class and nothing more — what it adds is
 * replaced or trimmed at an edge, never deleted from between two characters —
 * so no new DELETION can join two halves of a split needle. The REPLACEMENT
 * can still assemble one: `correct` + `U+2028` + `horse` reads `correct horse`.
 * A caller printing possibly secret-bearing text therefore masks after EACH
 * step: mask, strip, mask, `stripForDisplay`, mask. Masking only after this
 * helper is NOT enough — the last mask then sees separator-replaced, trimmed
 * text, so a needle that itself holds `U+2028` or edge whitespace, split in the
 * text by a strip-class character, no longer matches anywhere.
 *
 * Takes a `string`, as the strip does. A value whose runtime type is not
 * guaranteed (a record field read as an unchecked cast) needs its own guard
 * before it reaches here; `displaySafe` alone is the answer for an `unknown`.
 */
export function stripForDisplay(value: string): string {
  return displaySafe(stripControlChars(value));
}
