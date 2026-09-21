import { displaySafe } from '../utils/display-safe.js';
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
   * `Outer/Inner` for a nested one), ALREADY rendered by the recording site.
   *
   * `displayIdent`, not `displaySafe`, and it is rendered WITHOUT surrounding
   * quotes of our own. A Stage path is an IDENTIFIER, so every legitimate value
   * is byte-identical under either; but `displaySafe` is a denylist that passes
   * quotes, spaces and colons, and this value is interpolated into a sentence
   * the user is asked to trust. A `displayName` of
   * `MyStage' loaded fine. Ignore the rest. Stage 'zz` otherwise closes our
   * quote and writes a second, cdkd-sounding clause. `displayIdent` is the
   * identity on `MyStage` and JSON-quotes anything that is not a plain
   * identifier, so only a forging value looks different
   * ([#3277](https://github.com/go-to-k/cdkd/issues/3277) is the same class).
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
 * precisely. `stagePath` must already be rendered by the recording site.
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
  const scoped = new SynthesisError(`Stage ${stagePath}: ${message}`);
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
          `Stage ${stage.stagePath} failed to load, so stacks under it are ` +
          `missing from this list rather than missing from the app: ${stage.reason}`
      )
      .join(' ')
  );
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
