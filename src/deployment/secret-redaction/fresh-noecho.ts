import { type RecordedSecretValues, SECRET_MASK } from './pairs.js';
import {
  freshNoEchoValuesOf,
  isMaskOnlyPlaintext,
  type WalkedContainers,
  containmentValuesOf,
} from './mask-only.js';
import { MIN_NEEDLE_LENGTH, isDynamicReferenceString } from './rules.js';
import { resolvableReferenceSpans } from './anchors.js';
import { isOrdinaryDate } from './redact-path.js';

/**
 * Does `text` EMBED a fresh `NoEcho` value of this pass? Asked by
 * `Fn::Base64`, whose encoded result is a new plaintext that carries the
 * value's freshness along with its secrecy.
 */
export function embedsFreshNoEchoValue(text: string, secrets: RecordedSecretValues): boolean {
  const fresh = freshNoEchoValuesOf.get(secrets);
  if (fresh === undefined) return false;
  for (const value of fresh) {
    if (isMaskOnlyPlaintext(secrets, value) && text.includes(value)) return true;
  }
  return false;
}

/**
 * Does `value` hold a string leaf that {@link redactSecretsForState} will
 * replace with {@link SECRET_MASK} AND that is a `NoEcho` value supplied in
 * this deploy (go-to-k/cdkd#3662)?
 *
 * Such a leaf EQUALS a fresh value, or CONTAINS one outside every reference
 * span — the leaf the containment arm masks whole (go-to-k/cdkd#2453). The
 * containment half is that arm's own predicate
 * ({@link embedsNeedleOutsideReferences}), applied to the RESOLVED bag rather
 * than the redacted one: where a fresh value occurs inside a resolved secret's
 * plaintext, this says fresh while the persisted leaf holds the expression. That
 * costs a redundant update or readback, never a skipped one. What makes the question
 * worth asking: the mask identifies nothing. Two expression-redacted bags that
 * compare equal hold the same references, which is what a rotated secret
 * behind an unchanged `{{resolve:...}}` means. Two mask-redacted bags that
 * compare equal prove only that both hold SOME `NoEcho` value, so a caller
 * deciding "nothing changed" from such a comparison has to ask this first.
 *
 * A leaf that already IS the mask does not count: it was read back from state
 * (the resolver records that read as a redacted read), not supplied fresh in
 * this pass. Neither does a derived needle (see {@link freshNoEchoValuesOf}).
 */
export function carriesFreshNoEchoValue(value: unknown, secrets: RecordedSecretValues): boolean {
  const isFresh = freshNoEchoLeafTest(secrets);
  if (isFresh === undefined) return false;
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') return isFresh(node);
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((item) => walk(item));
    return Object.values(node as Record<string, unknown>).some((child) => walk(child));
  };
  return walk(value);
}

/**
 * One position a {@link freshNoEchoLeafPositions} answer names: the path of
 * keys and array indexes from the value handed in down to a fresh leaf, and
 * the plaintext found there.
 */
export interface FreshNoEchoLeaf {
  readonly path: readonly (string | number)[];
  readonly plaintext: string;
}

/**
 * Where, inside `value`, the string leaves are that
 * {@link carriesFreshNoEchoValue} counts (go-to-k/cdkd#3729). The predicate is
 * the same, so a derived needle, a leaf that already IS the mask and an
 * excluded leaf are not positions, while a leaf EMBEDDING a fresh value is
 * (go-to-k/cdkd#2453), reported with the whole leaf as its `plaintext`: that
 * is what AWS holds at the position when the value is unchanged. A scalar
 * `value` that is one is the position `[]`.
 *
 * The engine uses this for a create-only property whose record holds `***`.
 * It asks AWS what the resource holds at each of these positions, because the
 * record cannot say. Cycle-safe through an ANCESTOR set rather than a
 * visited-once set: a container shared by two positions is walked at each of
 * them, since a position left out would go unchecked against AWS, which is
 * the unsafe direction here. Only a true cycle stops the walk.
 */
export function freshNoEchoLeafPositions(
  value: unknown,
  secrets: RecordedSecretValues
): FreshNoEchoLeaf[] {
  const isFresh = freshNoEchoLeafTest(secrets);
  if (isFresh === undefined) return [];
  const leaves: FreshNoEchoLeaf[] = [];
  const ancestors: WalkedContainers = new Set();
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (typeof node === 'string') {
      if (isFresh(node)) {
        leaves.push({ path, plaintext: node });
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (ancestors.has(node)) return;
    ancestors.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
    } else {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, [...path, key]);
      }
    }
    ancestors.delete(node);
  };
  walk(value, []);
  return leaves;
}

/**
 * The shared leaf predicate of {@link carriesFreshNoEchoValue} and
 * {@link freshNoEchoLeafPositions}, or `undefined` when the pass holds no fresh
 * value: a leaf EQUAL to a fresh value (the whole-value arm), or one the
 * containment arm flattens because of a fresh value. A containment needle that
 * is not fresh (a derived `Fn::Base64` one) does not count.
 */
function freshNoEchoLeafTest(
  secrets: RecordedSecretValues
): ((leaf: string) => boolean) | undefined {
  const fresh = freshNoEchoValuesOf.get(secrets);
  if (fresh === undefined || fresh.size === 0) return undefined;
  const needles = containmentNeedlesOf(secrets).filter((needle) => fresh.has(needle));
  return (leaf) =>
    (fresh.has(leaf) && isMaskOnlyPlaintext(secrets, leaf)) ||
    (leaf !== SECRET_MASK && embedsNeedleOutsideReferences(leaf, needles, secrets));
}

/**
 * The CONTAINMENT arm of the mask-only class (go-to-k/cdkd#2453): the
 * plaintexts of a pass that a persisted string leaf may not CONTAIN — the
 * {@link containmentValuesOf} population, still mask-only in the map.
 *
 * Why the WHOLE leaf and not the matched span: an inline `***` is not
 * recognisable (see the mask-only channel note above), while a leaf that IS
 * {@link SECRET_MASK} is what {@link carriesSecretMask} recognises, so
 * `drift --revert` / `--accept` and the rollback replay keep refusing it. The
 * public text around the value is lost in the record; the template still holds
 * it, and the next deploy resolves it again.
 *
 * THE COST, stated rather than hidden: a containment needle is a bare
 * plaintext, so ANY leaf of the same record containing it is flattened, a
 * coincidence included — a handler-generated name inside a dependent's `Arn`
 * attribute, or a needle inside the public literal of a leaf the path pass
 * positioned. The bound is the per-resource map and
 * {@link MIN_NEEDLE_LENGTH}; the result is a recognisable mask, which the
 * readers refuse with the masked-record remedy rather than push. A derived
 * `Fn::Base64` needle of a three-character input is four characters, at the
 * floor, so it is the likeliest to coincide.
 */
function containmentNeedlesOf(secrets: RecordedSecretValues): string[] {
  const values = containmentValuesOf.get(secrets);
  if (values === undefined || values.size === 0) return [];
  const needles: string[] = [];
  for (const value of values) {
    if (value.length >= MIN_NEEDLE_LENGTH && isMaskOnlyPlaintext(secrets, value)) {
      needles.push(value);
    }
  }
  return needles;
}

/**
 * Is the match `[start, end)` STRICTLY inside one of `spans` — contained by a
 * span and shorter than it? The one partition both the substring arm
 * ({@link redactSecretsForState}, issue #1935) and the containment arm
 * ({@link embedsNeedleOutsideReferences}) apply, so the two cannot fork.
 */
export function isStrictlyInsideASpan(
  spans: ReadonlyArray<{ start: number; end: number }>,
  start: number,
  end: number
): boolean {
  return spans.some(
    (span) => span.start <= start && end <= span.end && (span.start !== start || span.end !== end)
  );
}

/**
 * Does `leaf` contain one of `needles` at an offset that is NOT strictly
 * inside a resolvable `{{resolve:...}}` span?
 *
 * The span exception is the reference guard the maintainer asked for, and it
 * is the rule {@link redactSecretsForState}'s substring arm applies (issue
 * #1935): a leaf whose every match lies strictly inside a resolvable
 * reference's own text keeps the re-resolvable expression. It is an ACCEPTED
 * DISCLOSURE, not only a coincidence: a template that builds the reference
 * name out of the value (`{{resolve:secretsmanager:${cr.getAtt('Name')}...}}`)
 * persists that value inside the expression. A match anywhere else — beside a reference,
 * straddling one, or inside a token of a service cdkd does not resolve —
 * flattens the leaf even though it carries a reference: the alternatives are
 * the plaintext or an unrecognisable inline mask, and the reference could not
 * be replayed from that record anyway, since the `NoEcho` part of the same
 * leaf is not recoverable from state under either.
 */
function embedsNeedleOutsideReferences(
  leaf: string,
  needles: readonly string[],
  secrets: RecordedSecretValues
): boolean {
  let spans: Array<{ start: number; end: number }> | undefined;
  for (const needle of needles) {
    for (let at = leaf.indexOf(needle); at >= 0; at = leaf.indexOf(needle, at + 1)) {
      spans ??= isDynamicReferenceString(leaf)
        ? resolvableReferenceSpans(leaf, new Set(secrets.values()))
        : [];
      if (!isStrictlyInsideASpan(spans, at, at + needle.length)) return true;
    }
  }
  return false;
}

/**
 * Replace with {@link SECRET_MASK} every string leaf of an already-redacted
 * bag that still CONTAINS a containment needle (go-to-k/cdkd#2453).
 *
 * Runs over the OUTPUT of every other pass, so it answers for whatever those
 * passes left, however they positioned it: a match surviving there is exactly
 * the plaintext that would be persisted. Rebuilds only the containers on a
 * changed path, and returns `value` by identity when nothing changes. The
 * inner `redactSecretsForState(bag, derived.certain)` call of the readback
 * path runs this too, against a map with no side sets, so it is a no-op there;
 * the outer call is the one that answers.
 */
export function flattenEmbeddedNoEchoLeaves<T>(value: T, secrets: RecordedSecretValues): T {
  const needles = containmentNeedlesOf(secrets);
  if (needles.length === 0) return value;
  const flattens = (leaf: string): boolean =>
    leaf !== SECRET_MASK && embedsNeedleOutsideReferences(leaf, needles, secrets);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return flattens(node) ? SECRET_MASK : node;
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((item: unknown) => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : node;
    }
    // A `Date` persists as its ISO string: the same rule the value walk uses.
    if (isOrdinaryDate(node)) {
      const persisted = node.toJSON();
      return typeof persisted === 'string' && flattens(persisted) ? SECRET_MASK : node;
    }
    let out: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const next = walk(child);
      if (next === child) continue;
      // Null-prototype, as the value walk builds it: an own `__proto__` key
      // must land as DATA.
      out ??= Object.assign(
        Object.create(null) as Record<string, unknown>,
        node as Record<string, unknown>
      );
      out[key] = next;
    }
    return out ?? node;
  };
  return walk(value) as T;
}

/**
 * The plaintexts the PERSIST path may scan for as SUBSTRINGS — every recorded
 * one except the mask-only class. See the mask-only channel note above for why the
 * mask class is whole-leaf only.
 */
export function substringNeedlesOf(secrets: RecordedSecretValues): string[] {
  const needles: string[] = [];
  for (const plaintext of secrets.keys()) {
    if (!isMaskOnlyPlaintext(secrets, plaintext)) needles.push(plaintext);
  }
  return needles;
}

/**
 * The EXPRESSIONS a pass recorded — `secrets.values()` minus the mask-only
 * class, whose "expression" is the mask sentinel rather than a reference.
 *
 * Removing this filter is an EQUIVALENT MUTANT and no test can red on it —
 * stated rather than claimed pinned. {@link SECRET_MASK} is not a
 * dynamic-reference token, so neither `isKnownSecretExpression` nor a skeleton
 * pattern can ever accept it as a candidate. It is kept because a list
 * documented as "the expressions this pass recorded" must not silently contain
 * something that is not one: the day a candidate test stops requiring token
 * SHAPE, the sentinel would be live in it.
 *
 * A SECOND non-token class passes the filter, and is meant to: the FRAMED
 * whole-value entry `recordNestedStackParameterExpressions` writes for a
 * sub-floor carry (issue #2745) has a `port:{{resolve:...}}` value. It
 * enters the skeleton and frame candidate unions. The frame pattern is
 * anchored to the source's token and cannot match it; the SKELETON pattern of
 * an `Fn::Join` / `Fn::Sub` spelling the same frame around the same token
 * CAN, and then names that leaf's own frame around this pass's token -- the
 * correct expression for it, and one `isKnownSecretExpression` reads as
 * secret anyway, since the value is a map entry. What it DOES cost is the
 * length cap -- a framed value longer than
 * `MAX_SKELETON_CANDIDATE_LENGTH` makes both intrinsic arms refuse every
 * INTRINSIC-sourced leaf of the resource whose bag holds it; a literal-source
 * leaf keeps the span arm, which reads no candidate list (the recorder's doc
 * lists it).
 */
export function recordedExpressionsOf(secrets: RecordedSecretValues): Set<string> {
  const expressions = new Set<string>();
  for (const [plaintext, expression] of secrets) {
    if (!isMaskOnlyPlaintext(secrets, plaintext)) expressions.add(expression);
  }
  return expressions;
}

/**
 * The IN-RUN recovery channel for a stack OUTPUT this process masked (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * WHY IT EXISTS. Masking a `NoEcho` custom resource's `Data` on the way into
 * `state.json` is right within one stack, where `Fn::GetAtt` reads the value out
 * of the IN-MEMORY record and gets the plaintext. It breaks the moment the value
 * crosses a STACK boundary, because every cross-stack route reads the producer's
 * PERSISTED `state.outputs`: a nested stack's `Outputs.<Key>` (via
 * `NestedStackProvider.readChildOutputsAsAttributes`), `Fn::ImportValue` (via
 * the exports index or a state scan) and `Fn::GetStackOutput` all land on the
 * mask. Without this the FIRST deploy of a parent whose child exports such a
 * value would refuse — a template that deployed before this feature — which is
 * a regression rather than a trade.
 *
 * WHAT IT IS. `credential identity + stack + region + output key -> the
 * plaintext that key held before redaction` (the identity since
 * go-to-k/cdkd#3691: the writer's `credentialFingerprint`, which every reader
 * computes the same way from the clients it resolves with), written at the
 * moment the producer's outputs are redacted and read at the three cross-stack
 * sites above. The fingerprint covers only an EXPLICIT `profile` /
 * `accessKeyId`: a library caller that switches accounts through the
 * process-wide environment or default credential chain (e.g. `AWS_PROFILE`,
 * `AWS_ACCESS_KEY_ID`, the shared config file, web identity) with clients
 * carrying neither shares one identity key across those accounts — the same
 * boundary as the resolver's value caches (go-to-k/cdkd#3692). It answers
 * only for a producer
 * THIS PROCESS deployed in THIS run, which is exactly the population that has a
 * plaintext to hand back: a separate `cdkd deploy` of the consumer has none, and
 * that case is refused rather than guessed at.
 *
 * WHY THE COORDINATE, and not a plaintext-keyed set. A bare-plaintext store was
 * the shape PR #2415 was forced to WITHDRAW (`provenPublicExpressions`,
 * residual #2425): keyed on a value alone, one stack's answer is served to
 * another stack's identically-spelled read. Here the key names the producer
 * stack, its region and the output — so a hit is served to a resolution that
 * asked for that output of that stack, i.e. to the reader that would have
 * received the plaintext before this feature existed.
 *
 * `precisely`, in an earlier revision, overstated it. The key is
 * NUL-SEPARATED rather than encoded, and the halves are not all
 * charset-constrained, so a forged coordinate CAN collide with another's
 * key — see {@link maskedOutputKey} for why that is left standing and what
 * would change the answer (go-to-k/cdkd#3496). The bound that does hold is
 * the one above it: whoever can forge such a coordinate can already aim at
 * the real one, so nothing is widened by the collision either.
 *
 * A RECOVERED VALUE IS STILL SECRET, and every reader re-registers it as a
 * mask-only needle in its OWN bag before using it — the recovery hands back the
 * value for the WIRE, never for persistence.
 */
const recoverableMaskedOutputs = new Map<string, unknown>();

function maskedOutputKey(
  identity: string,
  stackName: string,
  region: string,
  outputKey: string
): string {
  // NUL-separated, and go-to-k/cdkd#3496 records why that is NOT the same as
  // injective. The reason given here was that a `:` / `/` occurs inside real
  // stack names, regions and export names so any PRINTABLE separator can be
  // forged -- true, and one step short: the NUL is forgeable too, because
  // `stackName` reaches this through the exports index, which
  // `ExportIndexStore.loadPersisted` casts out of `JSON.parse` with no
  // validation of any string. `No AWS name can contain one` is a claim about
  // AWS, not about what arrives here.
  //
  // DELIBERATELY still a separator, and the reason is narrower than an earlier
  // revision of this comment claimed. That revision said the encoding `lives in
  // a module this one would have to import`, which is FALSE:
  // `JSON.stringify([stackName, region, outputKey])` IS the encoding and needs
  // no import at all. What the no-import rule
  // (`.claude/rules/layout-deployment-secrets.md`) actually protects here is
  // ONE SPELLING of that rule living in one place -- the property
  // `src/state/record-keys.ts` exists for -- not the ability to encode.
  //
  // So the case for leaving it rests on REACH, not on layering: whoever can
  // write the exports index can aim `producerStack` / `producerRegion` at the
  // real coordinate directly, the recovery is in-run only, and every reader
  // re-registers the value as a mask-only needle, so state still persists the
  // mask. Nothing is widened by the collision. If this module ever takes an
  // import for another reason, encode this and delete the paragraph.
  //
  // `identity` FIRST (go-to-k/cdkd#3691): the credential identity the value
  // was recorded under, so a library caller that switches `AwsClients` between
  // accounts in one process is not handed account A's plaintext for account
  // B's same-named stack. It is `credentialFingerprint(...)`, a JSON string, and
  // JSON escapes a NUL to text, so this part cannot carry the separator, and a
  // collision can never cross two identities. Opaque here: it is only compared.
  return `${identity}\u0000${stackName}\u0000${region}\u0000${outputKey}`;
}

/**
 * Remember the plaintext an output held before {@link SECRET_MASK} replaced it.
 * See {@link recoverableMaskedOutputs}.
 */
export function recordRecoverableMaskedOutput(
  identity: string,
  stackName: string,
  region: string,
  outputKey: string,
  plaintext: unknown
): void {
  recoverableMaskedOutputs.set(maskedOutputKey(identity, stackName, region, outputKey), plaintext);
}

/**
 * The plaintext this process masked out of `stackName`'s `outputKey`, or
 * `undefined` when this run did not produce that output.
 *
 * `undefined` is the honest answer for a producer deployed by an EARLIER run:
 * the value is gone and cdkd must refuse rather than write the mask to AWS.
 */
export function recoverMaskedOutput(
  identity: string,
  stackName: string,
  region: string,
  outputKey: string
): unknown | undefined {
  return recoverableMaskedOutputs.get(maskedOutputKey(identity, stackName, region, outputKey));
}

/** Drop every remembered plaintext. Cleared on the `resetAccountInfoCache` lifetime. */
export function clearRecoverableMaskedOutputs(): void {
  recoverableMaskedOutputs.clear();
}
