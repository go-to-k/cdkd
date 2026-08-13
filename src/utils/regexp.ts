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
