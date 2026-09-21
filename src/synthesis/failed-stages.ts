import { displayIdent, displaySafe, STACK_REF_MAX_CODE_POINTS } from '../utils/display-safe.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * A CDK Stage (`cdk:cloud-assembly` artifact) whose own manifest could not be
 * read, recorded by `AssemblyReader` so a later SELECTION failure can name it
 * (issue [#3482](https://github.com/go-to-k/cdkd/issues/3482)).
 *
 * Reading a stage stays tolerant on purpose: a Stage may reference a directory
 * that was never synthesized, and that must not abort a run targeting
 * unrelated top-level stacks. The cost of that tolerance is that every stack
 * under the stage silently leaves the assembly listing, so `cdkd deploy
 * 'MyStage/MyStack'` afterwards answers `No stacks matching ...` — an answer
 * that names a different problem than the one that occurred. These records are
 * what keeps the tolerant path honest.
 */
export interface FailedStage {
  /**
   * Hierarchical path of the Stage as the assembly names it (`MyStage`, or
   * `Outer/Inner` for a nested one), RAW.
   *
   * Raw because this field is a MATCH KEY as well as the subject of a
   * sentence: `patternTargetsStage` compares the user's own pattern against
   * it, exactly as `matchStacks` compares one against a stack's raw
   * `displayName`. Sanitizing at the write site made the two disagree — a
   * legitimate `new Stage(app, 'My Stage')` or a non-ASCII stage id renders
   * quoted or `<unrenderable>`, so the pattern naming it would never match and
   * the user got `Possibly unrelated:` for the very stage they named.
   *
   * So rendering happens at each DISPLAY site instead, through `displayIdent`
   * and without quotes of ours. A Stage path is an IDENTIFIER, and it is
   * interpolated into a sentence the user is asked to trust: `displaySafe` is
   * a denylist that passes quotes, spaces and colons, so a `displayName`
   * carrying `. Ignore the rest. Stage zz` reads as a second, cdkd-authored
   * clause. `displayIdent` is the identity on an ASCII-identifier path and
   * JSON-quotes anything else, so a forging value is visibly a quoted value
   * ([#3277](https://github.com/go-to-k/cdkd/issues/3277) is the same class).
   *
   * One accepted consequence, so it is not "fixed" later: a legitimate
   * non-ASCII stage id displays as `<unrenderable>`, because `displayIdent` is
   * an ASCII ALLOWLIST. That is the fail-closed direction, and ATTRIBUTION is
   * unaffected since it runs on the raw value — the stage is still matched and
   * named as targeted rather than hedged. What identifies it to the user is
   * then the PATTERN they typed, which `renderNoStackMatch` keeps in the head
   * whenever one was given; with no pattern and a non-ASCII stage the message
   * names neither, which is the known floor of this trade. Reaching for
   * `displaySafe` to render it reopens the forgery above.
   */
  stagePath: string;

  /**
   * Why the stage could not be read — free-form text, so `displaySafe` at the
   * recording site is the right renderer for it.
   */
  reason: string;
}

/**
 * Marks an error that already names the Stage it was raised under, so an outer
 * Stage does not prepend its own name on the way out. Follows the marker shape
 * of `markNonRetryable` in `src/deployment/retryable-errors.ts`: a
 * non-enumerable own property, read by presence.
 */
const STAGE_SCOPED_MARKER = Symbol.for('cdkd.stageScopedError');

/**
 * Re-raise a refusal caught while reading the CONTENTS of a Stage, with the
 * Stage named (issue [#3482](https://github.com/go-to-k/cdkd/issues/3482)).
 *
 * This is NOT a downgrade: every caller throws what this returns. The refusal
 * texts name the STACK — the stack a Stage produced carries a physical name
 * that need not embed the Stage's path, so without this the user is not told
 * which Stage directory to look in.
 *
 * The INNERMOST Stage wins: an error arriving already marked is returned
 * unchanged, so `Outer` does not restate what `Outer/Inner` said more
 * precisely. `stagePath` is the RAW path and is rendered here, for the reason
 * {@link FailedStage.stagePath} gives.
 *
 * The caught text goes through `displaySafe` although every throw reachable
 * from the recursion sanitizes at its own origin today: this catch's error
 * population is the whole recursive subtree, so the guard belongs to the CATCH
 * rather than to today's set of throws under it. It is therefore the identity
 * and a mutation probe on it finds no discrimination — stated so the next
 * reader gets the reason instead of the puzzle.
 *
 * No `cause`: the message already embeds the original's text in full, and
 * `formatError` renders a cause as a `Caused by:` line, which would print the
 * same sentence twice.
 */
export function stageScopedError(stagePath: string, error: unknown): unknown {
  if (error instanceof Error && STAGE_SCOPED_MARKER in error) return error;

  const message = displaySafe(error instanceof Error ? error.message : String(error));
  const scoped = new SynthesisError(`Stage ${renderStagePath(stagePath)}: ${message}`);
  // Keep the ORIGIN's frames under this error's own header line. Without it
  // `handleError`'s `--verbose` stack trace points at this re-raise rather
  // than at the refusal that fired, which is the one thing that trace is for.
  // The header is rewritten rather than the whole stack replaced, so the first
  // line still matches the message the user was shown.
  if (error instanceof Error && typeof error.stack === 'string') {
    const frames = error.stack.split('\n').slice(1).join('\n');
    if (frames.length > 0) scoped.stack = `${scoped.name}: ${scoped.message}\n${frames}`;
  }
  // Same reasoning as `markNonRetryable`: a non-extensible error is returned
  // unmarked rather than allowed to throw a `TypeError` in place of the
  // refusal. Losing the marker only costs an extra Stage prefix.
  if (Object.isExtensible(scoped)) {
    Object.defineProperty(scoped, STAGE_SCOPED_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return scoped;
}

/**
 * Render the sentence a stack-selection failure appends when a stage failed to
 * load, so the message reports the failed stage instead of answering "not
 * found" for a stack that may well exist under it.
 *
 * Returns `''` — appending nothing — when no stage failed, which is every
 * ordinary run. Otherwise it opens with `. ` so it reads as its own sentence
 * after a head that ends in a stack list.
 *
 * When one of the selection `patterns` targets a failed stage, that stage is
 * named as the explanation. Otherwise every failed stage is listed behind a
 * `Possibly unrelated:` hedge, since a physical stack name carries no stage
 * path and the link therefore cannot be proven from the pattern alone (see
 * `patternTargetsStage`). The sentence itself is spelled the same either way,
 * so one substring finds it.
 */
export function failedStageNote(
  patterns: readonly string[],
  failedStages: readonly FailedStage[] | undefined
): string {
  if (!failedStages || failedStages.length === 0) return '';

  // NO pattern was given, so the user asked for whatever the app has and the
  // selection still came back empty: every failed stage is part of the answer,
  // and hedging it would be false modesty. `some` over an empty list is
  // `false`, so this case has to be taken before the filter.
  const targeted =
    patterns.length === 0
      ? failedStages
      : failedStages.filter((stage) =>
          patterns.some((pattern) => patternTargetsStage(pattern, stage.stagePath))
        );
  const named = targeted.length > 0 ? targeted : failedStages;
  const hedge = targeted.length > 0 ? '' : 'Possibly unrelated: ';

  return (
    '. ' +
    hedge +
    named
      .map(
        (stage) =>
          `Stage ${renderStagePath(stage.stagePath)} failed to load, so stacks under it are ` +
          `missing from this list rather than missing from the app: ${stage.reason}`
      )
      .join(' ')
  );
}

/**
 * Render a Stage path into a message.
 *
 * `displayIdent` without quotes of ours, and with the cap a legitimately long
 * hierarchical name needs — the same argument `STACK_REF_MAX_CODE_POINTS`
 * exists for. See {@link FailedStage.stagePath} for why the stored value stays
 * raw and only this rendering is sanitized.
 */
export function renderStagePath(stagePath: string): string {
  return displayIdent(stagePath, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * Whether a user-supplied selection pattern could name a stack under
 * `stagePath`.
 *
 * Mirrors the routing rule in `src/cli/stack-matcher.ts`: a pattern WITHOUT
 * `/` is matched against the PHYSICAL CloudFormation stack name, which carries
 * no stage path at all (`MyStage-MyStack` is not decomposable — a stack may
 * override its own `stackName`), so such a pattern is never attributed to a
 * stage. A pattern WITH `/` is a display path, and its leading segments are
 * compared against the stage's, wildcard by wildcard, so `MyStage/MyStack` and
 * `MyStage/*` both attribute to `MyStage`.
 */
function patternTargetsStage(pattern: string, stagePath: string): boolean {
  if (!pattern.includes('/')) return false;

  const patternSegments = pattern.split('/');
  const stageSegments = stagePath.split('/');
  if (patternSegments.length < stageSegments.length) return false;

  return stageSegments.every((segment, i) => segmentMatches(patternSegments[i]!, segment));
}

/**
 * Wildcard-aware comparison of ONE path segment, matching how
 * `stackMatchesPattern` expands `*` in `src/cli/stack-matcher.ts`. The pattern
 * is the USER's own input, not an assembly-supplied value, so it is expanded
 * there the same way — metacharacters and all, so the two cannot disagree
 * about what a pattern means.
 *
 * The construction is guarded because SPLITTING on `/` can make an invalid
 * segment out of a valid pattern (`'(*x/y*)'` splits into `'(*x'`), and this
 * helper runs when the stack list is EMPTY, which is exactly when
 * `stackMatchesPattern` never evaluates and therefore never raises first. An
 * unusable pattern is simply not attributed: the note still prints, hedged,
 * instead of a `SyntaxError` replacing the message the user needed.
 */
function segmentMatches(patternSegment: string, segment: string): boolean {
  if (!patternSegment.includes('*')) return patternSegment === segment;
  try {
    return new RegExp('^' + patternSegment.replace(/\*/g, '.*') + '$').test(segment);
  } catch {
    return false;
  }
}
