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
 * Results keep input order. By default they are de-duplicated by `stackName`,
 * keeping the first SELECTED stack of each name; `{ dedupe: 'identity' }` keeps
 * every selected stack, for a caller that must see two stacks sharing one
 * physical name (a Stage deployed twice) and refuse (#5175).
 */
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../utils/display-safe.js';
import { globMatches, pathGlobMatches } from '../utils/glob-match.js';
import { stackForPathFormTarget } from './cdk-path.js';

export interface StackLike {
  stackName: string;
  displayName?: string;
  /**
   * The CDK Stage the stack was read from, or `undefined` for a top-level
   * stack of the app's own assembly. `--all` selects top-level stacks only.
   */
  stagePath?: string | undefined;
}

export interface MatchStacksOptions {
  /**
   * `'stackName'` (the default) keeps one stack per physical name: `deploy`,
   * `destroy`, `diff` and the other state-keyed commands address a stack by
   * `stackName`. `'identity'` keeps every selected stack, so the `cdkd local`
   * resolvers see both clones of a Stage that share a `stackName` and refuse
   * as ambiguous instead of running the first one's code (#5175).
   */
  dedupe?: 'stackName' | 'identity';
}

export function matchStacks<T extends StackLike>(
  stacks: T[],
  patterns: string[],
  options: MatchStacksOptions = {}
): T[] {
  if (patterns.length === 0) return [];

  const selected = new Set<T>();
  for (const pattern of patterns) {
    for (const stack of stacksForPattern(stacks, pattern)) selected.add(stack);
  }
  if (options.dedupe === 'identity') return stacks.filter((s) => selected.has(s));
  // Input order, one stack per `stackName` -- the first SELECTED one, never
  // merely the first stack of that name: `Prod/Api` must not come back as
  // `Beta/Api` when the two share a physical name (#5175).
  const seen = new Set<string>();
  return stacks.filter((s) => selected.has(s) && !seen.has(s.stackName) && seen.add(s.stackName));
}

/**
 * The outcome of resolving a `cdkd local` target's owning stack, shared by the
 * invoke and run-task resolvers, which map each miss onto their own error
 * class.
 *
 * - `no-prefix`: the target names no stack and the app has more than one.
 * - `not-found` / `ambiguous`: the target's stack head matched zero / more
 *   than one stack. Two stacks sharing a `stackName` (one Stage deployed
 *   twice) are BOTH matched by that name, never collapsed to the first.
 */
export type TargetStackSelection<T> =
  | { kind: 'found'; stack: T }
  | { kind: 'no-prefix' }
  | { kind: 'not-found'; pattern: string }
  | { kind: 'ambiguous'; pattern: string; matched: T[] };

/**
 * Resolve a parsed `cdkd local` target to its stack. A PATH-form target's
 * stack is the one whose display path (or physical name) is its LONGEST prefix
 * (`stackForPathFormTarget`, go-to-k/cdkd#3953); a wildcard head and the colon
 * form go through {@link matchStacks} by identity.
 *
 * The prefix lookup keeps the FIRST stack on a tie, and only two stacks
 * sharing a `stackName` can tie (a display path is unique, and it outranks an
 * equal physical name). Running the lookup over the reversed list finds the
 * LAST one, so a different answer means the head is a shared physical name:
 * ambiguous, not the first clone (#5175).
 */
export function selectTargetStack<T extends StackLike>(
  parsed: { stackPattern: string | null; pathOrId: string; isPath: boolean },
  target: string,
  stacks: readonly T[]
): TargetStackSelection<T> {
  if (parsed.stackPattern === null) {
    return stacks.length === 1 ? { kind: 'found', stack: stacks[0]! } : { kind: 'no-prefix' };
  }
  const byPrefix = stackForPathFormTarget(parsed, target, stacks);
  if (byPrefix) {
    if (stackForPathFormTarget(parsed, target, [...stacks].reverse()) === byPrefix) {
      return { kind: 'found', stack: byPrefix };
    }
    return {
      kind: 'ambiguous',
      pattern: byPrefix.stackName,
      matched: stacks.filter((s) => s.stackName === byPrefix.stackName),
    };
  }
  const matched = matchStacks([...stacks], [parsed.stackPattern], { dedupe: 'identity' });
  if (matched.length === 1) return { kind: 'found', stack: matched[0]! };
  if (matched.length === 0) return { kind: 'not-found', pattern: parsed.stackPattern };
  return { kind: 'ambiguous', pattern: parsed.stackPattern, matched };
}

/**
 * The refusal for an `ambiguous` {@link TargetStackSelection}: every matched
 * stack with its CDK path, and the next step. A CDK path names exactly one
 * stack, a shared physical name does not.
 */
export function renderAmbiguousTargetStack(pattern: string, matched: readonly StackLike[]): string {
  const sharedName = matched.length > 1 && matched.every((s) => s.stackName === pattern);
  const example = matched.find((s) => s.displayName && s.displayName !== s.stackName)?.displayName;
  const hint =
    example !== undefined &&
    displayIdent(example, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === example
      ? ` (e.g. '${example}/<construct path>')`
      : '';
  return (
    `Stack pattern ${renderPatternList([pattern])} matched ${matched.length} stacks: ` +
    `${matched.map(describeStack).join(', ')}` +
    (sharedName ? ', which share that physical stack name' : '') +
    (example !== undefined
      ? `. Name one stack by its CDK path, shown in parentheses${hint}.`
      : '. Use a more specific pattern.')
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
