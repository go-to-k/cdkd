/**
 * Match stacks against user-supplied name patterns, as the AWS CDK CLI does
 * ([#4474](https://github.com/go-to-k/cdkd/issues/4474)).
 *
 * A pattern is matched against the stack's HIERARCHICAL id (`displayName`:
 * `MyStack` for a top-level stack, `MyStage/MyStack` inside a Stage) with a
 * path-aware glob — `*` stays within one `/` segment, `**` spans any number —
 * so `'*'` selects the top-level stacks, `'MyStage/*'` one Stage's stacks and
 * `'**'` every stack. See `pathGlobMatches`.
 *
 * cdkd extension: a pattern that is EXACTLY a stack's physical CloudFormation
 * name (`MyStage-MyStack`) selects it, which the CDK CLI never does -- but only
 * when no stack's hierarchical id matches the pattern. Exact only, never a
 * glob: a wildcard over physical names would make `'*'` select every Stage's
 * stacks as well.
 *
 * Results are de-duplicated by `stackName`.
 */
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../utils/display-safe.js';
import { globMatches, pathGlobMatches } from '../utils/glob-match.js';

export interface StackLike {
  stackName: string;
  displayName?: string;
  /**
   * The CDK Stage the stack was read from, or `undefined` for a top-level
   * stack of the app's own assembly. `--all` selects top-level stacks only.
   */
  stagePath?: string | undefined;
}

export function matchStacks<T extends StackLike>(stacks: T[], patterns: string[]): T[] {
  if (patterns.length === 0) return [];

  const selected = new Set<string>();
  for (const pattern of patterns) {
    for (const stack of stacksForPattern(stacks, pattern)) selected.add(stack.stackName);
  }
  // Input order, deduplicated by `stackName`.
  const seen = new Set<string>();
  return stacks.filter(
    (s) => selected.has(s.stackName) && !seen.has(s.stackName) && seen.add(s.stackName)
  );
}

/**
 * The stacks ONE pattern selects. The hierarchical id wins: the exact physical
 * name is consulted only when no stack's id matched, so a name that is one
 * stack's construct id and ANOTHER stack's physical name selects only the
 * former, as the AWS CDK CLI does -- never both, which a union would, and a
 * `destroy --yes` would then delete a stack the user did not mean.
 */
function stacksForPattern<T extends StackLike>(stacks: readonly T[], pattern: string): T[] {
  const byId = stacks.filter((s) => pathGlobMatches(pattern, s.displayName ?? s.stackName));
  return byId.length > 0 ? byId : stacks.filter((s) => s.stackName === pattern);
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
 * `deploy`, `diff`, `list`, `publish-assets`, `scrub`, `import`, `export` and
 * `synth`, so each names the patterns it tried and the stacks the app has.
 *
 * A CDK Stage that failed to load never reaches here: it fails synthesis for
 * every command ([#3507](https://github.com/go-to-k/cdkd/issues/3507)), so
 * `available` is the whole app.
 */
export function renderNoStackMatch(
  patterns: readonly string[],
  available: readonly StackLike[]
): string {
  // Only the second clause varies, so an empty assembly never prints
  // `Available: ` with nothing after it.
  return patterns.length > 0
    ? `No stacks matching ${patterns.join(', ')} found in assembly. ` +
        (available.length > 0
          ? `Available: ${available.map(describeStack).join(', ')}`
          : 'The assembly has no stacks')
    : 'No stacks found in assembly';
}

/**
 * The patterns that matched no stack, which `matchStacks` drops silently.
 * Only `cdkd destroy` reports them, as the AWS CDK CLI's destroy does, whether
 * or not another pattern matched; `deploy`, `diff` and the rest stay silent on a
 * partly-unmatched selection and fail only on an EMPTY union, which is CDK's
 * `PATTERN_MUST_MATCH` ([#3507](https://github.com/go-to-k/cdkd/issues/3507)).
 */
export function unmatchedPatterns<T extends StackLike>(
  stacks: readonly T[],
  patterns: readonly string[],
  isPresent: (stack: T) => boolean = () => true
): string[] {
  // Deduplicated, so `cdkd destroy Typo Typo` names `Typo` once. A pattern
  // counts as matched only when the stack it SELECTS is present: destroy
  // resolves over the whole app and passes "is in state" here (#4474).
  return [...new Set(patterns)].filter((p) => !stacksForPattern(stacks, p).some(isPresent));
}

/**
 * The warning for {@link unmatchedPatterns}. `where` names the set searched
 * (`in state`). Patterns are the user's own argv, rendered as identifiers so a
 * value carrying the list separator cannot read as two.
 */
export function renderUnmatchedPatternsWarning(
  unmatched: readonly string[],
  where: string
): string {
  const verb = unmatched.length === 1 ? 'was' : 'were';
  return `${renderPatternList(unmatched)} matched no stack ${where} and ${verb} skipped.`;
}

/**
 * The warning for an exact name that IS a state record but not a stack of the
 * synthesized app -- a nested child, or another app's stack sharing the state
 * bucket. "Matched no stack in state" would be false for it.
 */
export function renderNotInAppWarning(names: readonly string[]): string {
  const one = names.length === 1;
  return (
    `${renderPatternList(names)} ${one ? 'is' : 'are'} in state but ${one ? 'is not a stack' : 'are not stacks'} ` +
    `of this app and ${one ? 'was' : 'were'} skipped. A nested stack is destroyed with its parent; ` +
    `another app's stack, with that app or by name through cdkd state destroy.`
  );
}

/**
 * User-supplied patterns, rendered as identifiers so a value carrying the list
 * separator cannot read as two.
 */
function renderPatternList(patterns: readonly string[]): string {
  return patterns
    .map((p) => displayIdent(p, { maxCodePoints: STACK_REF_MAX_CODE_POINTS, listMember: true }))
    .join(', ');
}

/**
 * Whether `pattern` could select `stack` on its own: the hierarchical id under
 * a path-aware glob, or the physical name exactly (the cdkd extension).
 * `pathGlobMatches` owns the glob rule. SELECTION goes through `matchStacks`,
 * where the id takes precedence over the physical name.
 */
export function stackMatchesPattern(stack: StackLike, pattern: string): boolean {
  return (
    pathGlobMatches(pattern, stack.displayName ?? stack.stackName) || pattern === stack.stackName
  );
}

/**
 * What `--all` selects: the stacks of the app's own assembly, as the AWS CDK
 * CLI's `--all` does (`MAIN_ASSEMBLY`). Stacks inside a CDK Stage are named
 * with `'Stage/*'` or `'**'` ([#4474](https://github.com/go-to-k/cdkd/issues/4474)).
 */
export function partitionTopLevel<T extends StackLike>(
  stacks: readonly T[]
): { topLevel: T[]; inStages: T[] } {
  const topLevel: T[] = [];
  const inStages: T[] = [];
  for (const stack of stacks) (stack.stagePath === undefined ? topLevel : inStages).push(stack);
  return { topLevel, inStages };
}

/**
 * The one line `--all` prints when it left stacks inside CDK Stages out, so a
 * run that used to include them does not narrow silently.
 */
export function renderAllLeftOutStageStacks(inStages: readonly StackLike[]): string {
  const n = inStages.length;
  return (
    `--all selects top-level stacks only; ${n} stack${n === 1 ? '' : 's'} inside a CDK Stage ` +
    `${n === 1 ? 'was' : 'were'} left out (${inStages.map(describeStack).join(', ')}). ` +
    renderStagePatternAdvice(inStages)
  );
}

/**
 * The advice both `--all` lines end with: each Stage's own `'<stage>/*'`
 * pattern, pasteable, and `'**'` for every stack. A Stage path that is not a
 * plain identifier is left out of the list rather than rendered in a form the
 * shell would read differently; `'**'` still reaches it.
 */
function renderStagePatternAdvice(inStages: readonly StackLike[]): string {
  const stagePatterns = [
    ...new Set(
      inStages
        .map((s) => s.stagePath)
        .filter(
          (p): p is string =>
            p !== undefined && displayIdent(p, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === p
        )
    ),
  ].map((p) => `'${p}/*'`);
  return stagePatterns.length > 0
    ? `Name them with ${stagePatterns.join(', ')}, or select every stack with '**'.`
    : `Select them with '**'.`;
}

/**
 * The stacks a pattern selected before [#4474](https://github.com/go-to-k/cdkd/issues/4474)
 * that the CDK-compatible selection in `selected` no longer holds. The old
 * rule was one glob whose `*` crossed `/`: over the physical name for a
 * pattern without `/`, over the display path for one with it (`'Stage/*'`
 * reached `Stage/Parent/Child`). `deploy` and
 * `destroy` name them in one line, so a script written against the old rule
 * (`cdkd destroy '*'` meaning every stack) does not narrow silently.
 */
export function stacksNoLongerSelected<T extends StackLike>(
  stacks: readonly T[],
  patterns: readonly string[],
  selected: ReadonlySet<string>
): { stacks: T[]; patterns: string[] } {
  const oldRule = (p: string, s: StackLike) =>
    globMatches(p, p.includes('/') ? (s.displayName ?? s.stackName) : s.stackName);
  const dropped = stacks.filter(
    (s) => !selected.has(s.stackName) && patterns.some((p) => oldRule(p, s))
  );
  return {
    stacks: dropped,
    patterns: [...new Set(patterns)].filter((p) => dropped.some((s) => oldRule(p, s))),
  };
}

/** The line for {@link stacksNoLongerSelected}. */
export function renderStacksNoLongerSelected(
  patterns: readonly string[],
  dropped: readonly StackLike[]
): string {
  const n = dropped.length;
  const one = patterns.length === 1;
  const inStages = dropped.filter((s) => s.stagePath !== undefined);
  // `'<stage>/*'` reaches only a Stage's DIRECT stacks; a deeper one (a Stack
  // nested in a Stack inside the Stage) is named by its path instead.
  const direct = (s: StackLike) =>
    s.stagePath !== undefined &&
    (s.displayName ?? s.stackName).split('/').length === s.stagePath.split('/').length + 1;
  return (
    `${renderPatternList(patterns)} now ${one ? 'matches' : 'match'} the CDK path, with * inside ` +
    `one segment, and no longer ${one ? 'selects' : 'select'} ${n} stack${n === 1 ? '' : 's'} ` +
    `${one ? 'it' : 'they'} used to (${dropped.map(describeStack).join(', ')}). ` +
    // The Stage advice only when it reaches EVERY named stack.
    (inStages.length === dropped.length && inStages.every(direct)
      ? renderStagePatternAdvice(inStages)
      : inStages.length > 0
        ? "Name each by the CDK path shown in parentheses, or select every stack with '**'."
        : 'Name each by the CDK path shown in parentheses.')
  );
}

/**
 * The refusal `--all` raises when the app's own assembly has no stacks and
 * every stack sits inside a CDK Stage, as the AWS CDK CLI's `--all` refuses a
 * stage-only app.
 */
export function renderAllNoTopLevelStacks(inStages: readonly StackLike[]): string {
  return (
    `--all selects top-level stacks only, and this app has none: every stack is inside a ` +
    `CDK Stage (${inStages.map(describeStack).join(', ')}). ` +
    renderStagePatternAdvice(inStages)
  );
}
