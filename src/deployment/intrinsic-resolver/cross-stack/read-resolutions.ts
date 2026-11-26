import type { IntrinsicLeafResolution, RecordedSecretValues } from '../../secret-redaction.js';

/**
 * How a cross-stack read's PRODUCER value was re-resolved, per pass bag and
 * source key (go-to-k/cdkd#7050): the producer's persisted spelling (`input`,
 * `arn:...:{{resolve:...}}`), what it resolved to, and each replacement made.
 *
 * The re-resolution (`reresolveCrossStackValue`) is the one place holding
 * both: the resolver files it under the consumer's `Fn::ImportValue` /
 * `Fn::GetStackOutput` object (`recordCrossStackReadSpan`), so the persist
 * walk places each token at the span it was substituted at, by provenance,
 * instead of masking a leaf whose consumed secret no span places. A key
 * re-resolved two different ways in one pass is poisoned (no record: the leaf
 * masks, the fail-closed direction).
 */
type ReadResolution = Pick<
  IntrinsicLeafResolution,
  'input' | 'output' | 'substitutions' | 'complete'
>;
const CONFLICTING = Symbol('conflicting cross-stack read resolution');
const readResolutions = new WeakMap<
  RecordedSecretValues,
  Map<string, ReadResolution | typeof CONFLICTING>
>();

/** Note how the pass owning `secrets` re-resolved the producer value read under `key`. */
export function noteCrossStackReadResolution(
  secrets: RecordedSecretValues,
  key: string,
  resolution: ReadResolution
): void {
  let table = readResolutions.get(secrets);
  if (table === undefined) {
    table = new Map();
    readResolutions.set(secrets, table);
  }
  const seen = table.get(key);
  if (seen === undefined) {
    table.set(key, {
      input: resolution.input,
      output: resolution.output,
      substitutions: resolution.substitutions.map(({ token, value, secret }) => ({
        token,
        value,
        secret,
      })),
      complete: resolution.complete,
    });
    return;
  }
  if (seen === CONFLICTING) return;
  const same =
    seen.input === resolution.input &&
    seen.output === resolution.output &&
    seen.complete === resolution.complete &&
    seen.substitutions.length === resolution.substitutions.length &&
    seen.substitutions.every(
      (s, i) =>
        s.token === resolution.substitutions[i]!.token &&
        s.value === resolution.substitutions[i]!.value &&
        s.secret === resolution.substitutions[i]!.secret
    );
  if (!same) table.set(key, CONFLICTING);
}

/** The re-resolution noted under `key` whose output is `output`, or `undefined`. */
export function crossStackReadResolutionOf(
  secrets: RecordedSecretValues,
  key: string,
  output: string
): ReadResolution | undefined {
  const seen = readResolutions.get(secrets)?.get(key);
  if (seen === undefined || seen === CONFLICTING || seen.output !== output) return undefined;
  return seen;
}
