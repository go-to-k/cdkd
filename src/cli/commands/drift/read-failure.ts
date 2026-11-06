/**
 * `cdkd drift`: the not-compared reasons and the read-failure breaker.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import type { ResourceState } from '../../../types/state.js';
import type { NotComparedCause } from './outcome.js';
import { noEchoPathsClause } from './redaction.js';

/**
 * One-line human phrasing for a {@link NotComparedCause}, used per entry in the
 * human report's `NOT fully compared` block.
 *
 * Written as an exhaustive record rather than a `switch` with a default, so
 * adding a cause is a COMPILE ERROR here instead of silently rendering as
 * whatever the default said. That is the same guarantee #2135 bought at the
 * variant level, applied to the cause level -- and it is the level that
 * defaulted quietly when issues #2151 / #1945 added `readFailed`.
 */
export function notComparedReason(cause: NotComparedCause, record?: ResourceState): string {
  // Issue #3465: "deploy a change" does not clear every refusal class, and
  // which one this is lives on the record, not in the cause.
  const refusedRemedy = cause === 'baselineRefused' ? refusedBaselineRemedy(record) : undefined;
  const REASONS: Record<NotComparedCause, string> = {
    refused:
      'cdkd refused to resolve a dynamic reference its state records ' +
      '(spell the reference as a full ARN, which names its region)',
    unresolvedToken:
      'its state records a `{{resolve:...}}` spelling cdkd resolves for nobody ' +
      '(permanent; a re-run cannot clear it)',
    readFailed: 'the read or comparison threw, so NONE of its properties were compared',
    readAborted:
      `cdkd never read it: ${DRIFT_READ_FAILURE_BREAKER_THRESHOLD} reads in a row earlier in ` +
      'this stack, the same way it would have been read, failed — expired credentials, a ' +
      'revoked role, a permission all of them need, or a burst of throttling — so cdkd ' +
      'stopped reading that way (fix the cause, or re-run if it was throttling)',
    unreadableRecord:
      'its state record is not readable as a resource — not an object, carrying no ' +
      "resource type, or holding a 'properties' map that is not an object — so there was " +
      'nothing to compare (repair or re-import the record)',
    unreadableMap:
      "the record's whole 'resources' map is not a JSON object, so no resource in it could " +
      'be read or compared (repair or re-import the record)',
    baselineRefused:
      'a `cdkd import` run refused to capture its observed baseline, so the only ' +
      'baseline available is the recorded properties that refusal already found ' +
      'untrustworthy' +
      (refusedRemedy === undefined
        ? ' (deploy a change to this resource to restore one)'
        : `. ${refusedRemedy}`),
    noEchoParameter:
      `its state holds a NoEcho parameter's value only as the redaction mask${noEchoPathsClause(record)}, ` +
      'so that value was not compared — every other property was (permanent by design; a ' +
      'deploy compares it with AWS)',
    uncertifiedBaseline:
      'its recorded baseline holds the redaction mask at a position cdkd could not pair ' +
      'with the secret reference there, so that position was not compared — every other ' +
      'property was (deploy a change to this resource to re-capture the baseline)',
  };
  return REASONS[cause];
}

/**
 * How many READS in a row within one stack must throw before `cdkd drift` stops
 * reading that stack through the same read path (go-to-k/cdkd#2207). Each later
 * resource it would have read that way is reported `notCompared: readAborted`.
 * Resources that never reach AWS (skipped, deny-listed, refused baselines)
 * neither count nor reset.
 *
 * A breaker on CONSECUTIVE failures rather than a classifier of the error: it
 * keeps go-to-k/cdkd#2151's fix for the interleaved case — one unreadable
 * resource among readable ones resets the count and never trips it — without a
 * hand-written list of which error names are account-wide. Per STACK, not per
 * run: a stack in another region or account may well read fine. Per READ PATH:
 * every Cloud Control read (a resource the registry routes to Cloud Control,
 * and the fallback for an SDK provider with no `readCurrentState`) is one
 * path, and an SDK provider's own read the other. A role missing only
 * `cloudcontrol:GetResource` fails every Cloud Control read, and must not stop
 * the SDK reads that work. A path that trips stays tripped for the rest of
 * the stack. The threshold is not proof of an account-wide cause: a burst of
 * per-request throttling can trip it too, which a re-run clears.
 *
 * Only a READ that threw counts. A read that returned (a value, not-found, or
 * nothing) proves the credentials work, so it resets BOTH paths' counts — and
 * so keeps the interleaved guarantee across paths — including
 * when the COMPARISON after it then throws, which is a per-resource defect. A
 * type with no READ handler resets it too: that throw is about the type.
 */
export const DRIFT_READ_FAILURE_BREAKER_THRESHOLD = 5;

/** The two ways the drift loop reads a resource; the breaker counts each apart. */
export type DriftReadPath = 'provider' | 'ccApi';

/** How the trip warning names a read path. */
export const DRIFT_READ_PATH_LABELS: Record<DriftReadPath, string> = {
  provider: "through cdkd's own (SDK) resource providers",
  ccApi: 'through the Cloud Control API',
};

/**
 * The two Cloud Control error names that mean "this type has no READ handler".
 * `CloudControlProvider.handleError` recognizes the same pair, so the two sites
 * agree on the population by construction.
 */
const NO_READ_HANDLER_NAMES = new Set(['UnsupportedActionException', 'TypeNotFoundException']);

/**
 * The FULL phrase, deliberately -- see {@link isNoReadHandlerError}. Matching
 * loosely on `does not support` would route a genuine read failure to exit 0.
 */
const NO_READ_HANDLER_MESSAGE = /does not support READ action/i;

/**
 * Whether a throw out of the per-resource read means the type has NO READ PATH,
 * as opposed to a read that could have worked and did not.
 *
 * This is the taxonomy question issue
 * [#2151](https://github.com/go-to-k/cdkd/issues/2151) raised, and the property
 * it turns on is whether a RE-RUN CAN CLEAR IT. A type Cloud Control has no READ
 * handler for is permanent by construction, so routing it to `readFailed` would
 * make `cdkd drift` exit non-zero forever for every stack holding one -- the
 * same "unclearable in CI" hazard `unresolvedToken` is kept out of the exit code
 * for. It reports `unsupported` instead, which is not a new claim about it:
 * `CloudControlProvider.readCurrentState` signals the SAME condition by
 * returning `undefined` when the response carries no properties, and that
 * already reports `unsupported`. Which spelling arrives is AWS's choice, so the
 * two must not produce different outcomes.
 *
 * Matches on `name`, and WALKS THE CAUSE CHAIN rather than reading the top level
 * only. Be precise about why, because the obvious justification is wrong:
 * `CloudControlProvider.readCurrentState` re-throws everything but
 * `ResourceNotFoundException` RAW and never routes through that class's
 * `handleError`, so on today's code the only shape reaching here is the bare SDK
 * error -- which is what #2151 measured live, and which the top-level `name`
 * alone would catch.
 *
 * The walk is therefore for a wrap that does not exist YET, and it is cheap
 * insurance rather than dead code: `handleError` already recognizes this exact
 * pair and preserves the original as `cause`, so the day any read path is routed
 * through it -- or wrapped by a caller -- the top-level name becomes
 * `ProvisioningError` and a name-only check would silently start reporting a
 * permanent no-read-path condition as an actionable failure, at exit 2, forever.
 * A reader deleting the walk as unreachable should know that is the failure they
 * are buying.
 *
 * The message check is a FALLBACK for a re-wrap that kept neither the name nor
 * the cause, and it is deliberately the full phrase rather than `does not
 * support`: matching loosely would route a genuine read failure to `unsupported`
 * and exit 0 over a resource nobody compared, which is the direction this whole
 * lane exists to stop erring in. An error that loses its name AND its cause AND
 * its wording is reported `readFailed` and exits 2 -- loud, which is the safe
 * side.
 */
export function isNoReadHandlerError(err: unknown): boolean {
  // Its OWN try/catch, and this is not defensive padding: the only caller is the
  // per-resource catch, so a throw from HERE escapes that catch, the loop and the
  // command -- re-opening, from inside the guard, the exact hole the guard
  // closes. Reading `.name` / `.message` / `.cause` is a property GET, which a
  // getter or a Proxy trap can throw from. `false` on a throw routes the
  // resource to the loud `readFailed` arm, which is the safe direction.
  try {
    // Bounded rather than `while (true)`: a self-referential `cause` (a wrapper
    // that sets `cause` to itself, or a cycle across two wrappers) would
    // otherwise hang the command inside the very guard that exists to keep it
    // running.
    let current: unknown = err;
    for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth += 1) {
      const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
      if (typeof candidate.name === 'string' && NO_READ_HANDLER_NAMES.has(candidate.name)) {
        return true;
      }
      if (
        typeof candidate.message === 'string' &&
        NO_READ_HANDLER_MESSAGE.test(candidate.message)
      ) {
        return true;
      }
      current = candidate.cause;
    }
  } catch {
    return false;
  }
  return false;
}
