import {
  type RecordedSecretValues,
  recordResolvedPair,
  mergePairTables,
  sharePairTable,
} from './pairs.js';
import { carryLogOnlyValues, shareLogOnlyValues } from './log-only.js';
import {
  carryMaskOnlyMarks,
  carryPublicProofs,
  sharePublicProofs,
  containmentValuesOf,
  freshNoEchoValuesOf,
  noEchoParameterValuesOf,
  sideSetOf,
} from './mask-only.js';
import { mergeReferenceProvenance, shareReferenceProvenance } from './reference-provenance.js';
import { physicalNameCopiesOf, recordPhysicalNameCopy } from './physical-name-copies.js';

/**
 * RECORDING and REGISTRATION as one mechanism (go-to-k/cdkd#5048, stage 3 of
 * go-to-k/cdkd#1940).
 *
 * A pass's recording is its map (plaintext -> expression, or `SECRET_MASK`)
 * PLUS side tables keyed by the map INSTANCE ({@link RECORDING_KINDS}). A
 * second map that records on the pass's behalf (an
 * export name resolved through its own map, a pass map folded into an
 * accumulator) used to carry each table by its own helper, so a table nobody
 * named was dropped, and a carry placed after a throw or a `continue` dropped
 * everything (#1940's examples). Here every such map states, per kind, what
 * reaches the pass:
 *
 * - The ENTRIES always do, and so do the LOG-ONLY needles of a live scope:
 *   they are what every masker (log lines, error text, the deploy report)
 *   reads, so a value registered through a scope is registered with every
 *   masker of the pass. Neither is a policy choice.
 * - Every other kind is `carry` or `withhold`, in a {@link RecordingPolicy}
 *   that names ALL of them: a kind added to {@link RECORDING_KINDS} is a
 *   compile error at every scope and fold until each decides.
 *
 * A LIVE scope ({@link openRecordingScope}) has no release step: entries are
 * written through as they are recorded and a carried table IS the pass's
 * table, so nothing depends on a `finally` running, and a part the drain cap
 * stopped waiting for still lands when it records late (go-to-k/cdkd#2814,
 * where a merge-back in a `finally` dropped exactly that record).
 *
 * The persistence choke point (`redactForState`) refuses a scope's map as its
 * `secrets`: the scope's own tables are a SUBSET of the pass by design, so a
 * writer persisting with one would miss what the pass recorded elsewhere.
 *
 * Not yet under a policy: the per-pass POSITIONAL evidence (resolver
 * outcomes, nested-stack parameter expressions and reads, cross-stack
 * associations, intrinsic leaf resolutions, attribute id copies). A site that
 * needs one carries it by its own helper (`mirrorInheritedParameterReads`).
 */
export const RECORDING_KINDS = [
  'pairs',
  'log-only',
  'mask-only-marks',
  'reference-provenance',
  'physical-name-copies',
  'public-proofs',
] as const;

export type RecordingKind = (typeof RECORDING_KINDS)[number];

/** Per kind: does the pass receive it? Every kind is named, none defaulted. */
export type RecordingPolicy = Readonly<Record<RecordingKind, 'carry' | 'withhold'>>;

/** A live scope's policy: its log-only needles always reach the pass's maskers. */
export type LiveScopePolicy = RecordingPolicy & { readonly 'log-only': 'carry' };

/** A map that records on behalf of a pass, and the pass it records for. */
export interface RecordingScope {
  readonly secrets: RecordedSecretValues;
  readonly pass: RecordedSecretValues;
}

const scopeMaps = new WeakSet<RecordedSecretValues>();

/**
 * A map holding its OWN entries that also writes each through to its pass the
 * moment it is recorded. Only `set` writes through: it is the one operation a
 * recorder performs (grepped: no resolver path calls `delete` or `clear` on a
 * recording map), and a `delete` here would leave the pass one needle too
 * many, which over-redacts rather than leaks.
 */
class WriteThroughSecrets extends Map<string, string> {
  private readonly pass: RecordedSecretValues;

  constructor(pass: RecordedSecretValues) {
    super();
    this.pass = pass;
  }

  override set(plaintext: string, expression: string): this {
    super.set(plaintext, expression);
    this.pass.set(plaintext, expression);
    return this;
  }
}

/**
 * Open a LIVE recording scope over `pass`: a map whose own entries stay exact
 * (what a DECISION about this one resolution reads, e.g. "did a secret go into
 * this export name") while every entry and log-only needle it records is the
 * pass's at once, and each kind `policy` carries shares the pass's table.
 * A withheld kind stays on the scope only, which `policy` must justify at
 * the call site.
 *
 * `carry` SHARES a table, so it is wider than {@link foldRecording}'s for
 * `mask-only-marks`: the fold carries a mark only for a plaintext `to` holds
 * as mask-only, while a shared table holds every mark the scope records. No
 * scope carries this kind today; one that does inherits the wider reading.
 */
export function openRecordingScope(
  pass: RecordedSecretValues,
  policy: LiveScopePolicy
): RecordingScope {
  const secrets = new WriteThroughSecrets(pass);
  scopeMaps.add(secrets);
  shareLogOnlyValues(secrets, pass);
  for (const [kind, share] of Object.entries(SCOPE_SHARERS) as Array<
    [SharedKind, (scope: RecordedSecretValues, to: RecordedSecretValues) => void]
  >) {
    if (policy[kind] === 'carry') share(secrets, pass);
  }
  return { secrets, pass };
}

/** The kinds a live scope may share or withhold (log-only is always shared). */
type SharedKind = Exclude<RecordingKind, 'log-only'>;

/**
 * How a live scope SHARES each kind with its pass. A `Record` over every
 * kind but log-only, so a kind added to {@link RECORDING_KINDS} without a
 * sharer is a compile error here, never a `carry` silently ignored.
 */
const SCOPE_SHARERS: Readonly<
  Record<SharedKind, (scope: RecordedSecretValues, pass: RecordedSecretValues) => void>
> = {
  pairs: sharePairTable,
  'mask-only-marks': (scope, pass) => {
    for (const table of [freshNoEchoValuesOf, containmentValuesOf, noEchoParameterValuesOf]) {
      table.set(scope, sideSetOf(table, pass));
    }
  },
  'reference-provenance': shareReferenceProvenance,
  'physical-name-copies': (scope, pass) => {
    physicalNameCopiesOf.set(scope, sideSetOf(physicalNameCopiesOf, pass));
  },
  'public-proofs': sharePublicProofs,
};

/** Is `secrets` a live scope's map (never a pass to persist with)? */
export function isRecordingScope(secrets: RecordedSecretValues): boolean {
  return scopeMaps.has(secrets);
}

/**
 * Fold `from`'s recording into `to` NOW: every entry, then each kind `policy`
 * carries. For an accumulator built from several pass maps (the deploy's
 * outputs bag). Repeating a fold is safe: an entry re-set keeps its insertion
 * order, and an unchanged pair is left alone (`recordResolvedPair`).
 */
export function foldRecording(
  from: RecordedSecretValues,
  to: RecordedSecretValues,
  policy: RecordingPolicy
): void {
  if (from === to) return;
  for (const [plaintext, expression] of from) to.set(plaintext, expression);
  for (const [kind, carry] of Object.entries(FOLD_CARRIERS) as Array<
    [RecordingKind, (from: RecordedSecretValues, to: RecordedSecretValues) => void]
  >) {
    if (policy[kind] === 'carry') carry(from, to);
  }
}

/**
 * How {@link foldRecording} carries each kind, run in this order after the
 * entries (a mask-only mark is carried only for a plaintext `to` holds as
 * mask-only). A `Record` over every kind, so a kind added to
 * {@link RECORDING_KINDS} without a carrier is a compile error here.
 */
const FOLD_CARRIERS: Readonly<
  Record<RecordingKind, (from: RecordedSecretValues, to: RecordedSecretValues) => void>
> = {
  'mask-only-marks': carryMaskOnlyMarks,
  'reference-provenance': mergeReferenceProvenance,
  pairs: mergePairTables,
  'log-only': carryLogOnlyValues,
  'physical-name-copies': (from, to) => {
    for (const physicalId of physicalNameCopiesOf.get(from) ?? []) {
      recordPhysicalNameCopy(to, physicalId);
    }
  },
  'public-proofs': carryPublicProofs,
};

/**
 * The resolver's ONE recording of a resolved secret: the value-keyed entry
 * and, unless the value was read at a pinned generation, the pair keyed by
 * expression (go-to-k/cdkd#2485), in one call so neither can be written
 * without the other.
 */
export function recordSecretResolution(
  secrets: RecordedSecretValues,
  expression: string,
  plaintext: string,
  options: { readonly pairEvidence: boolean }
): void {
  secrets.set(plaintext, expression);
  if (options.pairEvidence) recordResolvedPair(secrets, expression, plaintext);
}
