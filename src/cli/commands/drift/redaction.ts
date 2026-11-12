/**
 * `cdkd drift`: the redaction choke point and the NoEcho / uncertified-baseline partitions.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import {
  type PropertyDrift,
  equalModuloMarkedMask,
  equalModuloMask,
} from '../../../analyzer/drift-calculator.js';
import { displaySafe } from '../../../utils/display-safe.js';
import {
  noEchoLeavesOf,
  isMarkedCoordinate,
  carriesSecretMask,
  pathCrossesDottedKey,
  SECRET_MASK,
  isUncertifiedBaselineMaskPosition,
  type RecordedSecretValues,
  redactForState,
  isSingleDynamicReferenceToken as isWholeDynamicReference,
  hasMaskableValues,
  maskSecretsInText,
  maskedLeafCoordinatesOf,
  maskReadbackAtCoordinates,
  valueAtCoordinate,
  maskAtCoordinates,
} from '../../../deployment/secret-redaction.js';
import type { ResourceState } from '../../../types/state.js';
import type { SecretPathSet } from './secret-resolution.js';

/**
 * The marked coordinates of a record, rendered as the property paths the
 * report names (`Key.Sub[0]`), for {@link notComparedReason}. Paths only,
 * never a value.
 */
export function noEchoPathsClause(record: ResourceState | undefined): string {
  const marked = record === undefined ? undefined : noEchoLeavesOf(record);
  if (marked === undefined || marked.length === 0) return '';
  const paths = marked.map((coordinate) =>
    coordinate
      .map((segment, i) =>
        typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`
      )
      .join('')
  );
  return ` at ${paths.map((path) => displaySafe(path)).join(', ')}`;
}

/**
 * The segments of a `--revert` walk path (`a.b[0].c`), the shape
 * {@link isMarkedCoordinate} compares against a record's `noEchoLeaves`.
 */
export function revertPathSegments(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    if (match === null) {
      segments.push(part);
      continue;
    }
    if (match[1] !== '') segments.push(match[1]!);
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]));
  }
  return segments;
}

/**
 * Split off the changes whose ONLY difference is a `NoEcho` parameter's mask
 * at a coordinate the record's `noEchoLeaves` names (go-to-k/cdkd#4043, schema
 * v11). State holds such a value only as `***`, whatever its type, so the
 * comparison cannot see it: the change is reported as `notCompared:
 * noEchoParameter` by PATH, never drift, and neither side is printed. A
 * difference anywhere else in the same subtree keeps the change.
 *
 * Runs on the COMPARISON values, before {@link redactDriftChanges}, as the
 * uncertified-baseline partition does. A record with no `noEchoLeaves` (a
 * pre-v11 one) splits off nothing. A path the comparator spells through a
 * dotted key is ambiguous and is kept.
 */
export function partitionNoEchoParameterChanges(
  changes: PropertyDrift[],
  record: ResourceState,
  baseline: Record<string, unknown>
): { kept: PropertyDrift[]; noEchoParameterPaths: string[] } {
  const marked = noEchoLeavesOf(record);
  if (marked === undefined || marked.length === 0) {
    return { kept: changes, noEchoParameterPaths: [] };
  }
  const properties = record.properties ?? {};
  // Marked, or an ANCESTOR of a marked coordinate: a readback the save could
  // not pair by identity is masked as a whole list, so a wholly masked
  // subtree that holds a marked coordinate accepts any present live value
  // (review LOW-5); a partly masked one is still compared leaf by leaf.
  const isMarked = (coordinate: readonly (string | number)[]): boolean =>
    isMarkedCoordinate(coordinate, marked) ||
    marked.some(
      (leaf) =>
        leaf.length > coordinate.length &&
        coordinate.every((segment, i) => String(segment) === String(leaf[i]))
    );
  // AT or inside a marked coordinate: the whole value there is the NoEcho one.
  const isWithinMarked = (coordinate: readonly (string | number)[]): boolean =>
    marked.some(
      (leaf) =>
        leaf.length <= coordinate.length &&
        leaf.every((segment, i) => String(segment) === String(coordinate[i]))
    );
  const kept: PropertyDrift[] = [];
  const noEchoParameterPaths: string[] = [];
  for (const change of changes) {
    const coordinate = change.path.split('.');
    const touchesMarked = marked.some((leaf) => {
      const n = Math.min(leaf.length, coordinate.length);
      for (let i = 0; i < n; i++) if (leaf[i] !== coordinate[i]) return false;
      return true;
    });
    if (
      touchesMarked &&
      carriesSecretMask(change.stateValue) &&
      !pathCrossesDottedKey(properties, change.path) &&
      !pathCrossesDottedKey(baseline, change.path) &&
      equalModuloMarkedMask(
        change.stateValue,
        change.awsValue,
        SECRET_MASK,
        coordinate,
        isMarked,
        isWithinMarked
      )
    ) {
      noEchoParameterPaths.push(change.path);
      continue;
    }
    kept.push(change);
  }
  return { kept, noEchoParameterPaths };
}

/**
 * Split off the changes that exist ONLY because the observed baseline holds an
 * uncertified-position mask (issue
 * [#3595](https://github.com/go-to-k/cdkd/issues/3595)).
 *
 * Issue [#2852](https://github.com/go-to-k/cdkd/issues/2852) writes
 * {@link SECRET_MASK} into `observedProperties` at every position the readback
 * walk could not pair with a dynamic reference in the source. No live value
 * equals the mask, so before this every such resource read `drifted` on every
 * run — a change nobody made, which `--accept` refused and no no-change deploy
 * cleared. The position is not drifted; it is UNKNOWN, and is reported that
 * way (`uncertifiedBaseline`, exit 2) instead.
 *
 * A change qualifies only when all three hold:
 *
 * - its state side carries a mask;
 * - the mask is the fail-closed class, not a `NoEcho` one
 *   ({@link isUncertifiedBaselineMaskPosition}) — a `NoEcho` mask keeps the
 *   issue #2274 disposition;
 * - the two sides are equal once each mask is allowed to match any present,
 *   non-null live value ({@link equalModuloMask}): a string, number or boolean
 *   since go-to-k/cdkd#5315 (a Step Functions `${name}` placed outside quotes
 *   reads back as a JSON number), and a container since go-to-k/cdkd#5333 (a
 *   definition whose KEY held a secret is masked whole). Anything else — a
 *   length change, a reorder, an edit beside the mask — stays real drift.
 *
 * Runs on the COMPARISON values, before {@link redactDriftChanges}: after it
 * the AWS side is itself a mask or an expression and the equality means
 * nothing. The split-off changes reach no printer, no `--json` payload and
 * neither remediation path; nothing about them is persisted or pushed.
 *
 * Accepted residuals, both inherent to a position cdkd cannot name: a secret
 * rotated (or edited) AT a masked position is not seen, and a masked element of
 * a declared-unordered array is sorted apart from its live counterpart and so
 * stays `drifted`.
 */
export function partitionUncertifiedBaselineChanges(
  changes: PropertyDrift[],
  properties: Record<string, unknown>,
  baseline: Record<string, unknown>
): { kept: PropertyDrift[]; uncertifiedPaths: string[] } {
  // No separate "observed baseline only" gate: on the `properties` fallback a
  // mask in the state side is a mask IN `properties`, which the discriminator
  // already reads as the `NoEcho` class.
  const kept: PropertyDrift[] = [];
  const uncertifiedPaths: string[] = [];
  for (const change of changes) {
    if (
      carriesSecretMask(change.stateValue) &&
      isUncertifiedBaselineMaskPosition(properties, change.path) &&
      // ...and the coordinate is unambiguous in the BASELINE too: a
      // readback-only key containing a dot is invisible to `properties`.
      !pathCrossesDottedKey(baseline, change.path) &&
      equalModuloMask(change.stateValue, change.awsValue, SECRET_MASK)
    ) {
      uncertifiedPaths.push(change.path);
      continue;
    }
    kept.push(change);
  }
  return { kept, uncertifiedPaths };
}

/**
 * Is a drift reported at `path` positioned on, or above, a known secret?
 *
 * The PREFIX direction is the one that matters: a secret sits at a leaf (or at
 * an array the comparator never descends), while a drift can be reported at any
 * ancestor of it — `Environment` rather than
 * `Environment.Variables.SECRET_PASSWORD` — whenever the two sides disagree
 * about the shape rather than the value. The reverse containment is checked too
 * and costs nothing.
 */
function isSecretBearingPath(path: string, secretPaths: SecretPathSet): boolean {
  if (secretPaths.size === 0) return false;
  for (const secretPath of secretPaths) {
    if (
      secretPath === path ||
      secretPath.startsWith(`${path}.`) ||
      path.startsWith(`${secretPath}.`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Redact one side of a drift entry.
 *
 * Two passes, and the second is the one issue #1914's review turned up. The
 * VALUE pass rewrites any recorded plaintext back onto its own
 * `{{resolve:...}}` expression, which is exact and is all that is needed while
 * the secret AWS holds is the secret the reference resolves to today.
 *
 * It stops being enough the moment those two differ, and they differ for the
 * most ordinary reason there is: a Secrets Manager ROTATION. The deployed
 * resource then still holds the PREVIOUS secret while the re-resolved baseline
 * holds the new one, so the path drifts and the AWS side matches no key in a
 * map built from today's value — it is a real secret that would be printed
 * verbatim and persisted by `--accept`. An out-of-band edit is
 * indistinguishable from it at this layer, so the POSITION decides: at a path
 * known to carry a secret, the only value ever shown is the expression itself,
 * and anything else becomes {@link SECRET_MASK}.
 *
 * `undefined` and `null` are exempt — an absent or null key discloses nothing,
 * and masking them would turn "AWS does not have this key" into "AWS has
 * something secret here", which is both wrong and less useful.
 */
function redactDriftValue(
  value: unknown,
  secrets: RecordedSecretValues,
  secretBearing: boolean
): unknown {
  const redacted = redactForState(value, { provenance: 'value-scan', secrets: secrets });
  if (!secretBearing) return redacted;
  if (redacted === undefined || redacted === null) return redacted;
  if (typeof redacted === 'string' && isWholeDynamicReference(redacted)) return redacted;
  return SECRET_MASK;
}

// `isWholeDynamicReference` — "is the WHOLE string a single `{{resolve:...}}`
// token and nothing else?" — is `secret-redaction.ts`'s
// `isSingleDynamicReferenceToken`, imported under this file's own name at the
// top rather than re-spelled here (issue #1936).
//
// The authority on what counts as a token is the RESOLVER, not this file: a
// predicate stricter than the resolver classifies as not-a-token a reference
// cdkd did resolve, and its plaintext is then persisted by whichever caller
// asked. A hand-copied twin that agrees byte-for-byte with its sibling does not
// help — being identical to the wrong answer is not agreement — so there is one
// definition and it is the shared one.
//
// A plain comment rather than a JSDoc block so nothing attaches it to the
// function below. Sharing matters here specifically because this predicate
// decides whether a value may be shown INSTEAD of `SECRET_MASK`, and
// `redactByPath` uses it to decide whether a leaf is already an expression — so
// a disagreement lets one of them treat as a token what the other treats as
// data.

/**
 * Why `--accept` must not persist this drift, or `undefined` when it may.
 *
 * Shared by the WRITE (`runAccept`) and the PLAN (`printAcceptPlan`) so the two
 * cannot disagree — a `--dry-run` that promises a write the real run refuses is
 * worse than either behaviour on its own.
 *
 * Three refusals, all about a value cdkd could not identify rather than about
 * secrecy as such:
 *
 * - A masked VALUE says AWS holds something at a known-secret path that is not
 *   what the reference resolves to. Writing `***` would corrupt the baseline
 *   and make the next deploy push the literal mask at AWS.
 * - A masked PATH says the readback answered with a map KEYED by a secret.
 *   `setAtPath` would then create a key literally named `***` — and when
 *   `awsValue` is `undefined` it would INSERT that key rather than removing the
 *   real one, so the value check alone does not cover it.
 * - A masked BASELINE (issue #2274) says the state side itself is the mask —
 *   a `NoEcho` custom resource's `Data` or the `Fn::Base64` encoding of a
 *   secret redacted out of `state.json`, or a readback position the #2852
 *   walk could not certify. Accepting would write the live plaintext over a
 *   deliberate redaction, which is the opposite of what the mask is for.
 *
 * The path check is what makes the value exemptions safe: `redactDriftValue`
 * lets `undefined` / `null` / a whole expression through unmasked, which is
 * right for a value and says nothing about the path it sits at.
 */
export function acceptRefusalReason(
  change: PropertyDrift,
  maskedPaths: SecretPathSet
): string | undefined {
  if (!maskedPaths.has(change.path)) return undefined;
  if (change.path.includes(SECRET_MASK)) {
    return (
      'its property NAME came back carrying a secret value, so cdkd cannot name the key to ' +
      'write — and no redaction pass can clear it either, since they all walk values and never ' +
      'keys. ROTATE the secret; that is the only remedy'
    );
  }
  if (change.awsValue === undefined) {
    return (
      'AWS no longer reports it, and accepting an absence DELETES the key — which at or above ' +
      'a secret dynamic reference would erase the reference out of cdkd state. Use --revert to ' +
      'push it back, or re-deploy'
    );
  }
  if (change.stateValue === SECRET_MASK) {
    // Issue #2274. The BASELINE is the mask, so there is nothing to persist
    // over it: writing the AWS value would undo a redaction, and writing the
    // mask would corrupt the baseline into a literal `***`. cdkd cannot recover
    // the value either, because a `NoEcho` custom-resource `Data` has no
    // expression to re-resolve and the handler must not be re-invoked just to
    // read one. A rotation of a dynamic-reference secret reaches this arm too —
    // there the state side is a plaintext the map could not recognise — so the
    // wording names the shared fact (cdkd cannot say what belongs here) rather
    // than asserting one mechanism.
    //
    // The remedy names what ACTUALLY re-captures the baseline (issue #3595): a
    // bare "re-deploy" read as though any deploy would. A no-change deploy
    // replaces a mask only under the re-capture's two conditions
    // (`masked-baseline-recapture.ts`), and this arm is reached when something
    // at the position DIFFERS, which is exactly when the first one fails.
    //
    // And only the fail-closed mask is replaceable at all (issue #2881). A
    // `NoEcho` custom-resource value and the `Fn::Base64` encoding of a secret
    // (issues #2759 / #3119) are masked in `properties` too, which the
    // re-capture declines outright, and a deploy that updates the resource
    // masks them again on capture — so the message must not offer either a
    // remedy: that position is refused here for as long as it differs.
    return (
      'the value that belongs at this position is unknown to cdkd — the baseline holds only the ' +
      'redaction mask, so accepting would write AWS-held plaintext over a deliberate redaction. ' +
      'Where cdkd wrote that mask because it could not pair the readback with a secret reference, ' +
      'a deploy that CHANGES this resource re-captures the baseline, and a deploy that changes ' +
      'nothing replaces the mask only when the resource still reads back as its baseline ' +
      "records, the resource's own secret reference resolves to the value AWS holds there, and " +
      "nothing in the resource's recorded properties is masked. " +
      'Where the mask stands for a NoEcho custom-resource value or for the Fn::Base64 ' +
      'encoding of a secret value, cdkd never records the value, so no deploy replaces the mask'
    );
  }
  return (
    'it carries a secret dynamic reference and the value AWS currently holds is not the one ' +
    'the reference resolves to'
  );
}

/**
 * Redact resolved secret plaintext out of the drift entries that get REPORTED
 * (issue #1914).
 *
 * Both sides need it, for different reasons. `stateValue` comes from the
 * re-resolved comparison baseline, so at a secret leaf it now holds the
 * plaintext the state record deliberately does not store. `awsValue` is the
 * live readback, which holds that plaintext by construction. Either one
 * reaching `writeHumanReport` / `writeJsonReport` / the `--accept` and
 * `--revert` plans is the disclosure the redaction exists to prevent.
 *
 * Redacting `awsValue` also settles what `--accept` PERSISTS: that is the value
 * it writes into the baseline, so a secret one arrives at the state write
 * already carrying its expression — or, when it could not be recognised, as
 * {@link SECRET_MASK}, which `runAccept` refuses to persist.
 *
 * The PATH is redacted too. `redactSecretsForState` walks values and never
 * object KEYS, so a readback that answers with a map keyed by a secret (a
 * Lambda env var NAMED with one) renders as
 * `Environment.Variables.<plaintext>` in every printer. It is masked here
 * rather than assumed impossible, and a masked path also marks the change
 * secret-bearing, so `--accept` will not write a key it can no longer name.
 *
 * Returns the input array by identity when there is nothing to act on.
 */
export function redactDriftChanges(
  changes: PropertyDrift[],
  secrets: RecordedSecretValues,
  secretPaths: SecretPathSet,
  maskPaths: SecretPathSet
): { changes: PropertyDrift[]; maskedPaths: SecretPathSet } {
  // The third disjunct is issue #2274's, and without it the whole
  // redacted-baseline arm below is DEAD CODE for its own main population: a
  // stack whose only sensitive value is a `NoEcho` custom resource's `Data`
  // has NO dynamic reference anywhere, so both of the first two are empty and
  // the early return fires before the mask is ever looked at. Measured — the
  // report printed the live plaintext and `--accept` wrote it back. The scan
  // is over the change list this call is already walking, and the identity
  // return is kept for the (dominant) case where nothing is masked.
  if (
    // `hasMaskableValues`, not `size`: after a failed resolution the map is
    // empty while its LOG-ONLY needles still mask a path (issue #2102).
    !hasMaskableValues(secrets) &&
    secretPaths.size === 0 &&
    maskPaths.size === 0 &&
    !changes.some((change) => carriesSecretMask(change.stateValue))
  ) {
    return { changes, maskedPaths: new Set<string>() };
  }
  // The paths whose reported value cdkd could not identify. Returned rather
  // than re-derived downstream by comparing against `SECRET_MASK`: a property
  // whose real value happens to BE the string `***` would otherwise be refused
  // by `--accept` for no reason, and a masked PATH is not detectable from the
  // value at all.
  const maskedPaths = new Set<string>();
  const redacted: PropertyDrift[] = [];
  for (const change of changes) {
    // NOTE the asymmetry with `printRevertPlan`, which loudly WITHHOLDS its
    // key lists when a resource's references could not be resolved: here the
    // path is masked only by what `maskSecretsInText` can match. On that path
    // the MAP is empty, but the needles that resolved before the failure are
    // kept as LOG-ONLY ones of this bag (issue #2102), and this PRINTING masker
    // reads them — deliberately: a key carrying one is then masked, its values
    // with it, and `--accept` refuses it. A value cdkd never resolved still
    // cannot be recognised inside a KEY, and only the plan can withhold, since
    // a drift entry without its path says nothing at all.
    const maskedPath = maskSecretsInText(change.path, secrets);
    // Two independent reasons a change is secret-bearing, and they are kept
    // apart because only one of them licenses the DROP below: the POSITION is
    // known to hold a secret, or the property NAME turned out to carry one.
    const positionIsSecret =
      isSecretBearingPath(change.path, secretPaths) ||
      // Issue #2274: the mask positions, ancestor-matched exactly like the
      // dynamic-reference ones. They ride the SAME `positionIsSecret` flag
      // (which decides masking) and deliberately NOT `secretPaths` itself,
      // whose EXACT-leaf reading below licenses dropping a change — see the
      // `maskSecretPaths` note at the seed site.
      isSecretBearingPath(change.path, maskPaths);
    const nameCarriesSecret = maskedPath !== change.path;
    // A THIRD reason, and the one that needs no `secretPaths` entry to fire
    // (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)): the STATE
    // side already IS the mask. That happens where a `NoEcho` custom
    // resource's `Data` was resolved into this property and redacted on the way
    // into `state.json`. `secretPaths` cannot see it — that set is built from
    // dynamic-reference POSITIONS, and this value has no reference behind it at
    // all — so without this the AWS-current side, i.e. the live plaintext,
    // would be printed verbatim by every drift report and written back into
    // state by `--accept`. Both are the disclosure the redaction exists to
    // prevent, arriving through the one command that re-reads the resource.
    //
    // WHOLE-LEAF recognition ANYWHERE INSIDE the reported value, via
    // `secret-redaction.ts`'s own `carriesSecretMask`, not a whole-VALUE
    // equality. The first cut compared `change.stateValue === SECRET_MASK` and
    // was DEAD for the commonest shape: `calculateResourceDrift` does not
    // descend arrays, so a masked leaf under one (`ContainerDefinitions.0.
    // Environment.0.Value`) is reported as a change on `ContainerDefinitions`
    // whose `stateValue` is the whole array — never equal to the mask, so the
    // live plaintext was printed and `--accept` wrote it back. `secretPaths` is
    // seeded from the same masks by `collectSecretMaskPaths` and reaches the
    // same conclusion through `positionIsSecret`.
    //
    // MEASURED REDUNDANCY, stated rather than claimed pinned. Reverting THIS
    // predicate alone (to the whole-value equality) leaves the suite green,
    // because the seed already marks the position; reverting the SEED alone
    // reds one case (a change whose `stateValue` is an empty list while
    // `properties` holds the mask under it — no value predicate can see that);
    // reverting BOTH reds three, `--accept` writing the live plaintext among
    // them. So the seed is the load-bearing half and this one is
    // defence-in-depth. It is kept because the two answer about DIFFERENT
    // objects — the seed about the RESOURCE's bags, this about the change list
    // actually being redacted — and the day a comparator reports a leaf the
    // seed never walked, this is what still masks it. Do not "simplify" it back
    // to `===` on the strength of a green probe.
    //
    // It DOES catch a user whose real property value is literally `***`, and the
    // cost of that is bounded and correct-shaped: the value is reported masked
    // (which is what it already is) and `--accept` refuses it. There is no
    // evidence to narrow it further — a durable per-attribute `NoEcho` flag on
    // the state record is issue #2449 — and the alternative is printing a
    // secret.
    const stateValueIsMask = carriesSecretMask(change.stateValue);
    const secretBearing = positionIsSecret || nameCarriesSecret || stateValueIsMask;
    // EXACT, not the prefix match above. `isSecretBearingPath` deliberately
    // matches ANCESTORS so a drift reported above a secret is masked — but that
    // is the wrong granularity for the drop below, which claims a property
    // cannot be READ BACK. That is a fact about a leaf. A whole `Environment`
    // block disappearing from AWS (the console's "remove all environment
    // variables") is real drift the user wants to see, and pre-#1914 it WAS
    // reported, because the `{{resolve:` skip only ever covered leaf strings.
    const positionIsSecretLeaf = secretPaths.has(change.path);
    // An ABSENT AWS value at a secret-bearing path is "AWS cannot read this
    // back", not "AWS changed it" — a write-only credential (RDS / DocDB /
    // Neptune / ElastiCache / Cognito all declare no `getDriftUnknownPaths`)
    // simply is not returned by any readback. Dropping it RESTORES the
    // pre-#1914 behaviour exactly: `calculateResourceDrift`'s `{{resolve:`
    // skip used to cover this, and it stopped covering it precisely because
    // this PR makes the baseline arrive RESOLVED, so the state side is no
    // longer a `{{resolve:` string.
    //
    // Reporting it instead is not a smaller change, it is three bugs: `cdkd
    // drift` exits 1 forever on any stack with a templated credential;
    // `--accept` writes `undefined` at the path, which `setAtPath` turns into a
    // DELETED key — erasing the `{{resolve:...}}` reference from `properties`
    // altogether; and `--revert` re-pushes the credential to AWS on every run.
    // Masking-and-refusing instead of dropping fixes only the second.
    // Scoped to `positionIsSecretLeaf`, NOT to `secretBearing` and NOT to the
    // prefix match: the rationale is that a write-only credential is not
    // readable, which is a fact about ONE LEAF. A key whose NAME carries a
    // secret and that AWS no longer has is ordinary drift; so is a whole
    // subtree vanishing.
    if (positionIsSecretLeaf && change.awsValue === undefined) continue;
    const stateValue = redactDriftValue(change.stateValue, secrets, secretBearing);
    const awsValue = redactDriftValue(change.awsValue, secrets, secretBearing);
    // `secretBearing &&` is load-bearing: without it a property whose REAL
    // value is the string `***` at an ordinary path lands here and `--accept`
    // refuses it forever. At a secret-bearing path the two are genuinely
    // indistinguishable, so refusing is right there.
    if (
      maskedPath !== change.path ||
      (secretBearing && awsValue === SECRET_MASK) ||
      // An ABSENT value that survived the drop above — a subtree that vanished
      // from AWS, or an ancestor of a secret. It IS real drift and is reported,
      // but `--accept` must not persist it: `setAtPath(bag, path, undefined)`
      // DELETES the key, which at or above a secret position erases the
      // `{{resolve:...}}` reference out of `properties` altogether. `--revert`
      // is the operation that fixes this shape.
      (secretBearing && change.awsValue === undefined)
    ) {
      maskedPaths.add(maskedPath);
    }
    redacted.push({ path: maskedPath, stateValue, awsValue });
  }
  return { changes: redacted, maskedPaths };
}

/**
 * A drift baseline about to be written, masked at every coordinate the record
 * marks as served by a `NoEcho` source (go-to-k/cdkd#4043, Phase C, design
 * section 4.3): the `--accept` and `--revert` writers carry a LIVE value, and
 * a changed parent path, or a provider's echo of what the revert sent, can put
 * the plaintext at a marked leaf. An `observedProperties` baseline is a
 * readback, so a list is paired by its identity field and masked whole where
 * nothing pairs; a `properties` baseline is masked by index, as the deploy
 * writes it.
 */
/** @internal Exported for its unit tests. */
export function maskMarkedNoEchoBaseline(
  baseline: Record<string, unknown>,
  record: ResourceState,
  observed: boolean
): Record<string, unknown> {
  const marked = noEchoLeavesOf(record) ?? [];
  // An observed baseline also at every `***` leaf of `properties`, named or
  // not: a pre-v11 record names no coordinate for a value it holds only as
  // the mask (as the deploy's capture masks it).
  if (observed) {
    const coordinates = [...marked, ...maskedLeafCoordinatesOf(record.properties ?? {})];
    return coordinates.length === 0
      ? baseline
      : maskReadbackAtCoordinates(baseline, record.properties ?? {}, coordinates);
  }
  if (marked.length === 0) return baseline;
  // By index, except where a written value REPLACED the list a coordinate
  // runs through (AWS's order, not the record's): that coordinate is paired
  // through the list's identity field against the record instead, which masks
  // the whole list where nothing pairs.
  const recorded = record.properties ?? {};
  const listPathOf = (
    coordinate: readonly (string | number)[]
  ): (string | number)[] | undefined => {
    const list = coordinate.findIndex((segment) => typeof segment === 'number');
    return list < 0 ? undefined : coordinate.slice(0, list);
  };
  const replaced = marked.filter((coordinate) => {
    const path = listPathOf(coordinate);
    if (path === undefined) return false;
    // Every marked coordinate under the same list, masked on both sides, so
    // two marked elements of one list do not read as a replaced list.
    const underList = marked.filter(
      (other) => other.length > path.length && path.every((segment, i) => segment === other[i])
    );
    return (
      JSON.stringify(valueAtCoordinate(maskAtCoordinates(baseline, underList), path)) !==
      JSON.stringify(valueAtCoordinate(maskAtCoordinates(recorded, underList), path))
    );
  });
  const byIndex = maskAtCoordinates(
    baseline,
    marked.filter((coordinate) => !replaced.includes(coordinate))
  );
  if (replaced.length === 0) return byIndex;
  // No `noEchoLeaves` widening for a list masked WHOLE here: the one writer
  // that replaced a list on this arm was `--accept` writing `properties`,
  // which it no longer does (go-to-k/cdkd#6125); `--revert` only DROPS keys
  // from `properties`.
  return maskReadbackAtCoordinates(byIndex, recorded, replaced);
}
