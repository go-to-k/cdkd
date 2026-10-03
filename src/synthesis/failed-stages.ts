import { displayIdent, displaySafe, STACK_REF_MAX_CODE_POINTS } from '../utils/display-safe.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * A CDK Stage (`cdk:cloud-assembly` artifact) whose own `manifest.json` could
 * not be read is FATAL, for every command, exactly as an unreadable top-level
 * manifest is ([#3507](https://github.com/go-to-k/cdkd/issues/3507)). This
 * matches the AWS CDK CLI, whose `CloudAssembly` loads every nested assembly
 * before any stack is selected.
 *
 * It was tolerated once ([#3482](https://github.com/go-to-k/cdkd/issues/3482)):
 * the Stage's stacks silently left the synthesized app, and every selection
 * over the app (`--all`, a bare run, a wildcard) then acted on a smaller set
 * and could exit 0 -- a scrub reporting state clean over stacks it never read.
 * Do not reintroduce a tolerance here without the selection refusals it needs.
 *
 * A Stage path is RENDERED at each display site through `renderStagePath`
 * (`displayIdent`), never stored sanitized: it is an IDENTIFIER interpolated
 * into prose, and `displaySafe`'s denylist passes the quotes and spaces a
 * forging `displayName` needs ([#3277](https://github.com/go-to-k/cdkd/issues/3277)).
 */

/**
 * A Stage whose own manifest could not be read. A class of its own so that
 * `cdkd destroy`, which falls back to state when the app cannot be synthesized
 * at all (#3839), can tell this apart: the app is there and incomplete, and
 * the AWS CDK CLI refuses it outright, so destroy does too.
 */
export class StageLoadError extends SynthesisError {
  constructor(message: string) {
    super(message);
    this.name = 'StageLoadError';
    Object.setPrototypeOf(this, StageLoadError.prototype);
  }
}

/**
 * The error a Stage whose own manifest could not be read raises.
 *
 * `reason` is BUILT by the caller from the failure's own words (an errno code,
 * or a `JSON.parse` message, which carries no path) plus the directory through
 * `renderStagePath` -- never the caught message, which embeds the manifest
 * PATH and with it the assembly-chosen `directoryName`, twice.
 *
 * Marked stage-scoped, so an outer Stage re-raising it through
 * {@link stageScopedError} does not prepend its own name: the innermost Stage
 * is the one that failed.
 */
export function stageLoadError(stagePath: string, reason: string): SynthesisError {
  const error = new StageLoadError(
    `Stage ${renderStagePath(stagePath)} failed to load: ${reason}. ` +
      'Every stack under it is missing from the cloud assembly, so cdkd will not act on the app. ' +
      'Re-synthesize the app so the Stage is written, or point --app at a complete cloud assembly.'
  );
  markStageScoped(error);
  return error;
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
 * precisely. `stagePath` is the RAW path and is rendered here.
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
    // The header is `<name>: <message>`, which spans as many lines as the
    // MESSAGE does -- a one-line assumption would present a multi-line
    // refusal's trailing lines as stack frames.
    const headerLines = `${error.name}: ${error.message}`.split('\n').length;
    const frames = error.stack.split('\n').slice(headerLines).join('\n');
    if (frames.length > 0) scoped.stack = `${scoped.name}: ${scoped.message}\n${frames}`;
  }
  markStageScoped(scoped);
  return scoped;
}

function markStageScoped(error: Error): void {
  // Same reasoning as `markNonRetryable`: a non-extensible error is returned
  // unmarked rather than allowed to throw a `TypeError` in place of the
  // refusal. Losing the marker only costs an extra Stage prefix.
  if (Object.isExtensible(error)) {
    Object.defineProperty(error, STAGE_SCOPED_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

/**
 * Render a Stage path into a message.
 *
 * `displayIdent` without quotes of ours, and with the cap a legitimately long
 * hierarchical name needs — the same argument `STACK_REF_MAX_CODE_POINTS`
 * exists for.
 */
export function renderStagePath(stagePath: string): string {
  return displayIdent(stagePath, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}
