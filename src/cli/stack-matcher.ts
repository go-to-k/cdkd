/**
 * Match stacks against user-supplied name patterns.
 *
 * Patterns are evaluated against two fields:
 *
 * - `stackName` — the physical CloudFormation stack name (e.g. `MyStage-MyStack`)
 * - `displayName` — the hierarchical CDK path (e.g. `MyStage/MyStack`); falls
 *   back to `stackName` when the assembly does not carry one
 *
 * Routing is decided by whether the pattern contains `/`:
 *
 * - Pattern contains `/` → matched only against `displayName` (a `/` cannot
 *   appear in a CloudFormation stack name, so this is unambiguous)
 * - Pattern contains no `/` → matched only against `stackName`
 *
 * Wildcards (`*`) are supported in either case; every other character is
 * literal. Results are de-duplicated by
 * `stackName`, so a pattern that incidentally matches the same stack via both
 * fields is returned only once.
 */
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../utils/display-safe.js';
import { failedStageNote, type FailedStage } from '../synthesis/failed-stages.js';
import { globMatches } from '../utils/glob-match.js';

export interface StackLike {
  stackName: string;
  displayName?: string;
}

export function matchStacks<T extends StackLike>(stacks: T[], patterns: string[]): T[] {
  if (patterns.length === 0) return [];

  const seen = new Set<string>();
  const result: T[] = [];

  for (const stack of stacks) {
    const matched = patterns.some((pattern) => stackMatchesPattern(stack, pattern));
    if (matched && !seen.has(stack.stackName)) {
      seen.add(stack.stackName);
      result.push(stack);
    }
  }

  return result;
}

/**
 * Render a stack for diagnostic messages. When `displayName` differs from the
 * physical name, both are shown so the user can see which forms are valid as
 * patterns (e.g. `MyStage-Api (MyStage/Api)`).
 *
 * Both names come from the Cloud Assembly, and every one of this helper's
 * render sites interpolates the result into PROSE cdkd authors — `Available:
 * ...`, `Multiple stacks found: ...`, `Publishing assets for stack: ...`, the
 * last of which prints on a normal run rather than only on an error. So they
 * go through `displayIdent` ([#3277](https://github.com/go-to-k/cdkd/issues/3277)):
 * a `stackName` carrying `ESC [ 2 K` plus a carriage return ERASES cdkd's own
 * line and a newline forges a second one, and a value carrying quotes and
 * periods writes a cdkd-sounding clause.
 *
 * It is the identity on every legitimate `stackName` — a CloudFormation stack
 * name is `[A-Za-z0-9-]`, inside `PLAIN_IDENT`. It is NOT the identity on
 * every legitimate `displayName`: CDK sets that to the construct path, and
 * `constructs` rewrites only `/` in an id, so `new Stack(app, 'My Stack')` is
 * legal and prints `MyStack ("My Stack")`. Those quotes are not part of any
 * pattern, in a clause whose job is to say which forms ARE valid as patterns —
 * accepted, because the alternative is `displaySafe`, which passes the quotes
 * and spaces a crafted value needs, and the pattern still matches the RAW
 * name either way (`matchStacks` never sees this rendering).
 *
 * Sanitizing HERE rather than at the call sites is what keeps the rule whole:
 * the sites include `scrub.ts` and `destroy.ts`, which this change does not
 * touch, and a rule widened by hand is how the class survived being closed
 * twice already.
 */
export function describeStack(stack: StackLike): string {
  const name = displayIdent(stack.stackName, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
  if (stack.displayName && stack.displayName !== stack.stackName) {
    const display = displayIdent(stack.displayName, {
      maxCodePoints: STACK_REF_MAX_CODE_POINTS,
    });
    return `${name} (${display})`;
  }
  return name;
}

/**
 * The message a command raises when SELECTION came back empty — shared by
 * `deploy`, `diff`, `list` and `publish-assets`, which all built the identical
 * string by hand.
 *
 * `assembly` is required AND so is its `failedStages` member, which is the
 * point: a Stage that failed to load dropped every stack under it from
 * `available`, so "no stacks matching" names the wrong problem unless the
 * failure is reported with it (issue
 * [#3482](https://github.com/go-to-k/cdkd/issues/3482)). A REQUIRED member,
 * not an optional one — `{ failedStages?: ... }` accepts `{}`, so it fences
 * the argument while leaving the content unfenced, which is the wiring hole
 * this signature exists to close. `SynthesisResult.failedStages` is required
 * for the same reason, so passing the result satisfies it and an ad-hoc `{}`
 * does not.
 *
 * What it does NOT fence: a caller passing a STALE or empty list. That is
 * behaviour, not shape, and it is covered by a wiring test per command.
 */
export function renderNoStackMatch(
  patterns: readonly string[],
  available: readonly StackLike[],
  assembly: { failedStages: readonly FailedStage[] | undefined }
): string {
  // The PATTERN is kept whatever the assembly holds: dropping it left a user
  // who named a stack under a non-ASCII Stage with a message naming neither
  // their pattern nor the stage. Only the second clause varies, so an empty
  // assembly never prints `Available: ` with nothing after it.
  const head =
    patterns.length > 0
      ? `No stacks matching ${patterns.join(', ')} found in assembly. ` +
        (available.length > 0
          ? `Available: ${available.map(describeStack).join(', ')}`
          : 'The assembly has no stacks')
      : 'No stacks found in assembly';
  return head + failedStageNote(patterns, assembly.failedStages);
}

/**
 * `*` matches any run of characters and every other character is literal —
 * `globMatches` owns that rule for this matcher and for the failed-Stage
 * attribution alike ([#3508](https://github.com/go-to-k/cdkd/issues/3508)).
 */
export function stackMatchesPattern(stack: StackLike, pattern: string): boolean {
  const target = pattern.includes('/') ? (stack.displayName ?? stack.stackName) : stack.stackName;
  return globMatches(pattern, target);
}
