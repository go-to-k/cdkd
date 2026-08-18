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
