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
 * Wildcards (`*`) are supported in either case. Results are de-duplicated by
 * `stackName`, so a pattern that incidentally matches the same stack via both
 * fields is returned only once.
 */
import { failedStageNote, type FailedStage } from '../synthesis/failed-stages.js';

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
 */
export function describeStack(stack: StackLike): string {
  if (stack.displayName && stack.displayName !== stack.stackName) {
    return `${stack.stackName} (${stack.displayName})`;
  }
  return stack.stackName;
}

/**
 * The message a command raises when SELECTION came back empty — shared by
 * `deploy`, `diff`, `list` and `publish-assets`, which all built the identical
 * string by hand.
 *
 * `assembly` is REQUIRED, and that is the point: a Stage that failed to load
 * dropped every stack under it from `available`, so "no stacks matching" names
 * the wrong problem unless the failure is reported with it (issue
 * [#3482](https://github.com/go-to-k/cdkd/issues/3482)). Taking the whole
 * synthesis result rather than an optional extra argument makes a call site
 * that forgets it a COMPILE error instead of a silently weaker message. Pass
 * the `SynthesisResult` itself.
 */
export function renderNoStackMatch(
  patterns: readonly string[],
  available: readonly StackLike[],
  assembly: { failedStages?: readonly FailedStage[] }
): string {
  const head =
    patterns.length > 0
      ? `No stacks matching ${patterns.join(', ')} found in assembly. ` +
        `Available: ${available.map(describeStack).join(', ')}`
      : 'No stacks found in assembly';
  return head + failedStageNote(patterns, assembly.failedStages);
}

export function stackMatchesPattern(stack: StackLike, pattern: string): boolean {
  const target = pattern.includes('/') ? (stack.displayName ?? stack.stackName) : stack.stackName;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(target);
  }
  return target === pattern;
}
