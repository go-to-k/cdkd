import type { OutputsDeps } from './run-state.js';
import { markRedactedCause } from '../../retryable-errors.js';
import {
  maskSecretsInError,
  maskSecretsInText,
  unionOfSecretBags,
  type LiveScopePolicy,
  type RecordedSecretValues,
} from '../../secret-redaction.js';
import { describeAwsFailure, safeStringify } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';

/**
 * What an export NAME's own recording map hands its pass (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814), go-to-k/cdkd#5048).
 * The name resolves through a LIVE scope (`openRecordingScope`): its own
 * entries are what `exportNameSecretExposure` reads as "substituted into THIS
 * name", which must stay exact -- a view of the whole pass map (`cdkd scrub`'s
 * `SharedEntriesSecrets`) would report every secret the pass has recorded as
 * one the name holds, and refuse every alias -- while every entry and log-only
 * needle it records is the pass map's the moment it is recorded, a late record
 * (a part the drain cap stopped waiting for) or one on a throwing path
 * included. When this was a local copied into the pass map in a `finally`,
 * such a record reached nothing.
 *
 * Withheld, as before #5048 (the pass keeps only what the scope's entries
 * write through):
 *
 * - `pairs` (issue #2485): a name never positions a leaf, and a value
 *   re-using the same token records its own pair at the seam, so carrying
 *   them could add nothing -- what it COULD do is mark a pair conflicting (an
 *   `ssm` reference whose `Type` came back unclassifiable is never cached, so
 *   a name resolving it re-asks AWS and can see a value that moved since the
 *   value pass) and destroy the positioning the value pass had earned.
 * - `mask-only-marks`: they classify the values a pass persists or sends
 *   (containment flattening, the fresh-`NoEcho` skip), and a name persists
 *   no value; a value embedding the same needle records its own marks.
 * - `reference-provenance`: state schema v12 persists it for the references a
 *   value holds, and a name's reference is held by no value.
 * - `physical-name-copies`: they NARROW the persist scan (a match inside a
 *   read physical id is kept), so only a pass that read the id for the bag
 *   it persists may carry them.
 * - `public-proofs`: they let a persist walk keep a public token's resolved
 *   value; a name's lookup proves nothing about a value's.
 *
 * Exported for its test (`secret-redaction-recording-5048.test.ts`).
 */
export const EXPORT_NAME_SCOPE: LiveScopePolicy = {
  pairs: 'withhold',
  'log-only': 'carry',
  'mask-only-marks': 'withhold',
  'reference-provenance': 'withhold',
  'physical-name-copies': 'withhold',
  'public-proofs': 'withhold',
};

/**
 * What a failed Output resolution does, shared by both passes of
 * {@link resolveOutputs} so they cannot drift — the alias pass reports the
 * SAME failure for a name it could not resolve as the value pass does for a
 * value, which is what the single-pass shape did when both lived in one
 * `try`.
 *
 * Issue #1111 item 2: under `--strict-getatt` an unresolvable Output fails
 * the deploy instead of silently publishing nothing (which breaks downstream
 * `Fn::ImportValue` consumers with "export not found" long after this deploy
 * exits 0).
 *
 * The error is masked on both arms (issue
 * [#2728](https://github.com/go-to-k/cdkd/issues/2728)). The resolver's own
 * failures echo the offending reference token, a secret id / JSON key, or
 * an SSM parameter name, and `resolveSub` / `resolveJoin` re-enter
 * `resolveDynamicReferences` with the ASSEMBLED string — so a reference
 * built out of a value this same pass resolved from a secret puts that
 * plaintext into the echoed field (a JSON key assembled from the resolved
 * password says `key '<password>' not found`).
 *
 * TWO bags, the inherited one first, the same pair the resolver's
 * `maskSecretsForLog` masks against and for the same reason (issue #1903
 * round 2): on a nested-stack child the parent-decrypted parameter
 * plaintext is in `inheritedSecrets` and not in the pass map until a
 * `{Ref: <Param>}` resolution copies it across. No shape reaching this
 * handler before that copy has been constructed (every `${Param}` route
 * goes through `resolveRef`, which records), so the inherited bag is
 * defense in depth here — but two masking sites in one flow must not argue
 * opposite sides of the same question. `secrets` is the outputs pass's own
 * map: everything recorded before this handler runs, an `Export.Name`
 * resolution's entries included (its map writes each one through to the
 * pass map as the resolver records it, so they are here before the `catch`
 * is; issue #2814 replaced the `finally` that copied them at the end of
 * the block). Since issue #2563 a still-pending concurrent part
 * is in the PASS bag before this handler runs: the resolver drains every
 * part it started before a rejection reaches a caller. Not
 * unconditionally, and the weaker claim is the true one -- the drain is
 * bounded, and since the outputs pass wraps BOTH its loops in one budget
 * the bound spans the whole pass rather than one resolution: an early
 * failing output can leave a later `Export.Name` drain with no wait at all,
 * so a late record needs only a leg that had not finished recording by
 * then rather than one that outlived a full cap. (`inheritedSecrets` is the parent's, and no
 * resolution writes to it.)
 *
 * The strict arm's `cause` is masked as an OBJECT, through
 * `maskSecretsInError` — a clone of each `Error` link `errorCauseChain`
 * reaches (`ERROR_CAUSE_MASK_MAX_DEPTH` links, a cycle stops it; a
 * non-`Error` cause is kept verbatim), symbols included, so
 * `isMarkedNonRetryable`'s non-enumerable marker survives (the same reason
 * `provisionResource` uses it). No sink on the deploy path renders past
 * one level today (`formatError` prints `Caused by:` for a `CdkdError`'s
 * direct cause only), but that is a property of reachability, not of the
 * sinks: `cdkd scrub`'s `describeFailure` renders a chain, and is safe
 * because its boundary masks with this same helper and it walks the same
 * bounded `errorCauseChain`. Masking here gives a renderer within that
 * bound nothing to leak. A thrown STRING is masked as text; any other
 * non-`Error` value is not threaded as a cause at all (it would travel
 * unmasked, and `markNonRetryable` cannot have marked it).
 */
export function handleOutputResolutionFailure(
  deps: Pick<OutputsDeps, 'options' | 'logger'>,
  error: unknown,
  outputKey: string,
  outputs: Record<string, unknown>,
  secrets: RecordedSecretValues,
  inheritedSecrets: RecordedSecretValues
): void {
  // `error.message || error.name`, not `String(error)`: the latter prefixes
  // the class name, which usually said nothing the message did not, and
  // masking one text keeps the two arms reporting the same thing. The name
  // is kept as the fallback because it is the strictly-better half of the
  // prefix: `new Error()` has an empty message, and an AWS SDK error often
  // carries its code in the NAME over a generic message.
  // ONE pass over both bags (go-to-k/cdkd#4049): masked bag by bag, one
  // bag's shorter needle cut a longer needle the other held, and the rest
  // of it printed.
  const union = unionOfSecretBags([inheritedSecrets, secrets]);
  const detail = maskSecretsInText(
    error instanceof Error ? error.message || error.name : safeStringify(error),
    union
  );
  if (deps.options.strictGetAtt) {
    // The cause is masked on THIS arm only: `maskSecretsInError` clones the
    // whole chain and reads each link's `stack` accessor (a V8 trace
    // materialization per link), and the warn arm below never uses it.
    const cause: unknown =
      typeof error === 'string'
        ? maskSecretsInText(error, union)
        : maskSecretsInError(error, union);
    // `cause` is load-bearing, not decoration (issue #1874 review). The
    // non-retryable marker is a NON-ENUMERABLE symbol on the original error,
    // so re-wrapping without a cause DROPS it — while inlining the refusal's
    // full text, which for a resolver refusal includes template-controlled
    // identifiers. A logical id like `MyDependencyViolationHandler` then puts
    // `DependencyViolation` (a whitespace-free entry in the substring
    // table — the only one until issue #2116 added the name-cooldown error
    // codes) into this message, and the classifier reads it as transient.
    // That is reachable: this throw leaves `executeDeployment`, leaves the
    // child `deploy()`, passes through `NestedStackProvider.create`, and
    // lands in the PARENT's `withRetry` — so a nested stack would re-run a
    // whole child deploy plus rollback per retry on a path that can never
    // succeed. `isMarkedNonRetryable` walks the `.cause` chain, and the
    // masked clone carries the marker (see the doc comment), so threading
    // the cause preserves it. A thrown value that is neither an `Error`
    // nor a string is NOT threaded: `maskSecretsInError` hands it back by
    // identity, unmasked, and `markNonRetryable` marks `Error` instances
    // only, so such a value carries no marker this code could have put on
    // it — threading it would buy nothing and could carry plaintext.
    // go-to-k/cdkd#2676: `detail` is an error's (masked) message, which can
    // end in cdkd's own remedy command lines (`maskedRecordRemedyFor`), so it
    // is embedded as-is and LAST, after the flag note.
    //
    // go-to-k/cdkd#2319: this refusal reaches the persisted `RUN_FINISHED`
    // event, and an AWS-authored read failure names the caller on a denial.
    // It is named by its class plus the `--verbose` pointer, its text goes
    // to `debug` masked, and the refusal is stamped so a classifier reads
    // that text on the (masked) `cause` chain. A cdkd-authored refusal or a
    // transport failure keeps its text.
    const failure = error instanceof Error ? describeAwsFailure(error) : undefined;
    const refusalText = (text: string): string =>
      safeMsg`Failed to resolve output ${outputKey} ` +
      `(--strict-getatt promotes output resolution failures to deploy errors; ` +
      safeMsg`drop the flag to skip the output instead): ${asIsMessage(text)}`;
    if (failure?.redacted === true) deps.logger.debug(refusalText(detail));
    const refusal = new Error(
      refusalText(failure?.redacted === true ? failure.summary : detail),
      cause instanceof Error || typeof cause === 'string' ? { cause } : {}
    );
    throw failure?.redacted === true && cause instanceof Error
      ? markRedactedCause(refusal)
      : refusal;
  }
  deps.logger.warn(safeMsg`Failed to resolve output ${outputKey}: ${asIsMessage(detail)}`);
  outputs[outputKey] = undefined;
}
