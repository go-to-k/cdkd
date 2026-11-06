/**
 * `cdkd drift`: `--revert` live-value preservation at masked and uncertified leaves.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { equalModuloMask } from '../../../analyzer/drift-calculator.js';
import { hasPlainPrototype, hasOwnKey, ownValue, defineOwnKey } from '../../../utils/own-keys.js';
import {
  carriesSecretMask,
  identityKeyFor,
  SECRET_MASK,
  isSingleDynamicReferenceToken as isWholeDynamicReference,
  type RecordedSecretValues,
  recordMaskOnlyValue,
  recordMaskOnlyValuesIn,
} from '../../../deployment/secret-redaction.js';
import { getAtPath } from './accept.js';
import { isPlainRecord } from './revert-merge.js';
import { deepEqualUnordered } from './revert-payload.js';

/**
 * The live array to read a preserved leaf's replacement from, aligned to
 * `send`'s indices — or `undefined` when the two lists cannot be aligned at
 * all, which routes every mask beneath them to `unpreservablePaths` in the
 * mask walk and keeps the token in the token walk (see the wildcard
 * paragraph below for the split).
 *
 * WHY THIS IS NOT INDEX ALIGNMENT ANY MORE (issue
 * [#2884](https://github.com/go-to-k/cdkd/issues/2884)). Until issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852) the only mask in a
 * persisted bag came from a `NoEcho` custom resource's `Data` (issue #2274),
 * which sits at a scalar leaf of a property the template names. #2852 added a
 * second source, and it lands in exactly the population index alignment is
 * WRONG on: a leaf is masked BECAUSE `refuseUncertifiedReadbackPositions` could
 * not pair the two lists — an unkeyed array AWS reordered, or a keyed element
 * whose identity AWS normalised. A resource that produced a mask is by
 * construction one whose list does not come back in a stable order.
 *
 * Traced consequence, which is the issue #1498 / #1501 data-loss class this
 * module's own doc calls "strictly worse than the disclosure": for
 * `Environment: [{Name:'DB_PASS', Value:<ref>}, {Name:'REGION', Value:'...'}]`
 * echoed back case-normalised and reordered, the baseline becomes
 * `[{Name:'REGION',...}, {Name:'***', Value:'***'}]`, and an index-aligned
 * revert copies `live[1]` into the masked slot — shipping a duplicated `REGION`
 * and DELETING the password variable from the live task definition.
 *
 * So the alignment must be one AWS's own reordering cannot break:
 * {@link identityKeyFor} — the same rule the redaction walk pairs by, so the
 * two can never disagree about which elements correspond. It is asked FIRST and
 * with NO length test, which is a change from the first cut of this function: a
 * length test ahead of it refuses a list AWS legitimately ADDED an element to,
 * while the keyed lookup needs no such partner — a `send` element whose identity
 * AWS does not report simply yields no live value, which is already the
 * refusing arm.
 *
 * WITHOUT AN IDENTITY FIELD the array's own literal FRAME has to vouch for the
 * order — the same corroboration `unkeyedArrayPairsByAnchors` requires on the
 * redaction side — and the test is PER-LEAF. Three rules, and the first cut of
 * this function had none of them right:
 *
 * - **the lengths must match**, positional alignment being all that is left;
 * - **every leaf of `send` that is not a mask must equal `live`'s leaf at the
 *   same position** ({@link corroboratedLeafCount}), masked leaves wildcarded.
 *   A whole-ELEMENT exemption is what shipped first, and it corroborated
 *   NOTHING: {@link carriesSecretMask} is a DEEP, whole-subtree test, so an
 *   element carrying one mask anywhere skipped the comparison entirely.
 *   Measured on `[{Pw:'***',Role:'reader'},{Pw:'***',Role:'admin'}]` against a
 *   live list AWS returned in the other order — the admin password was written
 *   onto the reader entry and `provider.update` shipped it;
 * - **at most ONE element may carry a mask, and at least one non-mask leaf must
 *   actually have been COMPARED.** Two masked slots leave the surviving literal
 *   frame unable to say which mask goes where (two secret environment variables
 *   in one container definition is the ordinary shape), and zero compared
 *   leaves is the all-masked array {@link SECRET_MASK} produces when AWS
 *   normalised the identity field too — there the old `every` was vacuously
 *   true and the alignment rested on no evidence at all. With ONE masked slot
 *   and every other position literally equal, the single live element left over
 *   is the only value that can belong there.
 *
 * The `compared > 0` floor DELIBERATELY also refuses a single-element scalar
 * array — `[SECRET_MASK]` against one live value — even though one masked slot
 * against one live slot looks unambiguous. It is unambiguous only IF the live
 * list corresponds to this one, and with zero corroborated leaves the only
 * evidence for that is the length-1 match, which is no evidence: this is the
 * all-masked reading applied to its smallest shape, and the cost is a refusal
 * (the safe residual), not a wrong write. THAT COST SENTENCE IS THE MASK
 * WALK'S ALONE — for the token walk a refusal WRITES the token, so the same
 * floor inverts there and the singleton is accepted instead; see
 * `pairedLiveItems`' `acceptForcedSingleton` for the derivation.
 *
 * THE EVIDENCE MUST NOT BE MANUFACTURED BY A SIBLING PASS. `send` here must be
 * values the caller did not itself copy from `live` — see
 * {@link preserveLiveValuesAtMaskedLeaves}'s `corroborationSource` parameter
 * for the round-4 #2884 defect where the token pass's index-copied live values
 * corroborated their own indices.
 *
 * Refusing is the correct outcome for the MASK caller — it drops the whole
 * resource rather than send a guess. The TOKEN caller's refusal residual is
 * KEEPING the token (see below); both are the refusal `undefined` spells here,
 * and what it costs is the CALLER's contract, not this function's.
 *
 * PARAMETERISED WILDCARDS (issue #2893). This pairing now serves BOTH preserve
 * walks, because the two questions are identical — "which live element belongs
 * to this send element?" — and a second hand-rolled copy of the rule is
 * exactly how the `maskDeep` class of divergence starts. What differs per
 * caller is only WHICH leaf is the one being paired FOR (and so must be
 * wildcarded rather than compared) and what a refusal costs:
 *
 * - the MASK walk wildcards {@link SECRET_MASK} alone; a refusal drops the
 *   resource, so over-refusal is a safe posture there;
 * - the TOKEN walk wildcards a WHOLE `{{resolve:...}}` token (its live
 *   counterpart is the resolved value, so comparing would contradict on every
 *   array that pass exists to serve) AND the mask (owned by the LATER mask
 *   walk — comparing `***` against live would contradict spuriously, and
 *   treating it as evidence would be wrong in the other direction). Its
 *   refusal residual is keeping the token, which `provider.update` ships —
 *   a no-op for a record cdkd deployed, a preserved pre-existing breakage
 *   otherwise, and in both cases better than another element's live value
 *   copied into the wrong position.
 *
 * `carriesWildcard` must be the DEEP form of `wildcardLeaf` (an element
 * carrying a wildcard anywhere is a slot whose alignment part-rests on
 * abstention), and the one-slot bound applies to it: with two such elements
 * the surviving literal frame cannot say which wildcard goes where.
 *
 * `acceptForcedSingleton` (PR #2912 review, blocker 1) is where the two
 * callers' refusal COSTS meet the evidence rules, and it exists because a
 * rule that is sound for one arm BECAUSE of what its refusal costs cannot be
 * shared without re-deriving that cost. At `send.length === 1` against
 * `live.length === 1` no evidence question remains OPEN: the position is
 * FORCED (there is no other candidate to mis-pair with), and a positional
 * copy writes each live value back to its own position, so no
 * cross-POSITION donation — the credential-swap class every bound above
 * exists to stop — is constructible. Cross-IDENTITY donation is: the
 * bypass sits above the identity arm and its wildcard-identity guard, so
 * `[{Name:'DB', Value:<token>}]` against a live `[{Name:'OTHER', Value:'X'}]`
 * ships `{Name:'DB', Value:'X'}` — a value from a differently-identified
 * element. That is position-neutral (X lands at the exact position AWS
 * holds it), it is what the pre-#2893 positional descent did for every such
 * array, and the alternative writes the token over X; the trade is stated
 * here rather than claimed away. What the evidence rules still doubt at
 * 1-vs-1 is only "does this live list correspond to this send list at
 * all", and the two callers answer that doubt oppositely because their
 * refusal residuals invert:
 *
 * - the MASK walk refuses (`false`, the default): its residual is dropping
 *   the resource, so doubt costs a refusal — the safe direction, and the
 *   `[SECRET_MASK]`-vs-one-live-value reading its own doc defends;
 * - the TOKEN walk accepts (`true`): its residual WRITES the literal token
 *   over whatever AWS holds (`provider.update` ships it — the #1914
 *   corruption), so refusing on a forced position DESTROYS the live value a
 *   pairing would have preserved, while accepting is write-neutral even when
 *   the correspondence doubt is real (the copied value lands at the exact
 *   position AWS already holds it). Refusal buys nothing and costs a
 *   destructive write, so the token walk takes the pairing — which is also
 *   exactly the pre-#2893 behaviour for every 1-vs-1 array.
 *
 * The bypass sits ABOVE the identity arm deliberately: at 1-vs-1 an identity
 * mismatch (AWS normalised the one element's Name) changes which EVIDENCE
 * rule fails, not the forced position, and routing it through the identity
 * arm would re-open the same inverted cost through a different door. Every
 * bound below is untouched for `length >= 2`, where mis-pairing is real.
 */
export function pairedLiveItems(
  send: readonly unknown[],
  live: unknown,
  wildcardLeaf: (leaf: unknown) => boolean = isMaskLeaf,
  carriesWildcard: (value: unknown) => boolean = carriesSecretMask,
  acceptForcedSingleton = false
): readonly unknown[] | undefined {
  if (!Array.isArray(live)) return undefined;
  if (acceptForcedSingleton && send.length === 1 && live.length === 1) return live;
  const key = identityKeyFor(send, live);
  if (key !== undefined) {
    const byIdentity = new Map<unknown, unknown>();
    for (const item of live) byIdentity.set((item as Record<string, unknown>)[key], item);
    // A send element whose identity AWS does not report yields `undefined`
    // here, which is the "no live value" arm — the same answer as a missing
    // key. An identity value that is ITSELF a wildcard (a token, the mask) is
    // refused EXPLICITLY rather than trusted to miss: equality pairing on it
    // is a guess, and the miss is not structural — AWS can literally hold
    // `'***'` as an element's Name (a pre-#2274 shipped mask, or a user
    // literal), and a live element literally named by the token text is
    // producible the same way, so without this guard such an element would
    // "pair" and donate its live leaves (PR #2912 security review).
    //
    // The refusal is keyed on {@link isTokenOrMaskLeaf} for BOTH callers,
    // NOT on the caller's `wildcardLeaf` (issue
    // [#2919](https://github.com/go-to-k/cdkd/issues/2919)): the two
    // predicates answer different questions. `wildcardLeaf` says which leaf
    // is being paired FOR and so must abstain from corroboration; the
    // identity refusal says which identity VALUE is a guess to pair on, and
    // that set is the same for both walks. Keyed on the mask walk's
    // `isMaskLeaf` alone, a corroboration-bag identity holding a whole
    // `{{resolve:...}}` token (a keyed list whose identity FIELD carries a
    // surviving token, beside a mask elsewhere in the element) paired by
    // string equality with the live element cdkd's own literal echo names,
    // and donated that element's leaves into the masked slots — an
    // uncorroborated guess. Refused, the mask walk's residual is its safe
    // drop; the token walk's answer is unchanged, its wildcard already being
    // this predicate.
    return send.map((item) => {
      const identity = (item as Record<string, unknown>)[key];
      return isTokenOrMaskLeaf(identity) ? undefined : byIdentity.get(identity);
    });
  }
  // No identity field: the literal frame has to vouch for the order, per LEAF.
  if (live.length !== send.length) return undefined;
  let wildcardSlots = 0;
  let compared = 0;
  for (let i = 0; i < send.length; i++) {
    if (carriesWildcard(send[i])) wildcardSlots++;
    const corroborated = corroboratedLeafCount(send[i], live[i], wildcardLeaf);
    if (corroborated === undefined) return undefined;
    compared += corroborated;
  }
  if (wildcardSlots > 1 || compared === 0) return undefined;
  return live;
}

/** The MASK walk's wildcard: the redaction mask alone. */
function isMaskLeaf(leaf: unknown): boolean {
  return leaf === SECRET_MASK;
}

/**
 * The TOKEN walk's wildcard: a leaf whose WHOLE value is a `{{resolve:...}}`
 * token, plus the mask (which that walk never touches but must abstain on —
 * see {@link pairedLiveItems}). A MIXED leaf (a token embedded in a longer
 * string) is deliberately NOT a wildcard: the token walk does not preserve it
 * either, and its live counterpart genuinely differs, so letting it abstain
 * would make every partially-resolved string an unbounded free pass.
 */
export function isTokenOrMaskLeaf(leaf: unknown): boolean {
  if (leaf === SECRET_MASK) return true;
  return typeof leaf === 'string' && leaf.includes('{{resolve:') && isWholeDynamicReference(leaf);
}

/**
 * Deep form of {@link isTokenOrMaskLeaf}, for the one-slot bound.
 *
 * Cycle-guarded like its sibling `carriesSecretMask`, via the same inner
 * closure so the visited set is not a callable parameter (PR #2912 review):
 * the value walked here is an element of `buildRevertNewProperties`' output,
 * which carries RAW `readCurrentState` returns — provider-authored, not
 * JSON-round-tripped — so a self-referential object must answer `false`
 * rather than throw `RangeError` out of the pairing. The guard bounds the
 * PAIRING frame only: a cyclic PLAIN element still overflows the enclosing
 * preserve walk one frame later (pre-existing, caught by `runRevert`'s
 * per-resource payload-build catch); what this guard keeps alive is the
 * NON-PLAIN cyclic element, which that walk returns by identity and only
 * this slot count ever descends.
 */
export function carriesTokenOrMask(value: unknown): boolean {
  const seen = new Set<object>();
  const walkNode = (node: unknown): boolean => {
    if (isTokenOrMaskLeaf(node)) return true;
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(walkNode);
    return Object.values(node).some(walkNode);
  };
  return walkNode(value);
}

/**
 * How many of `send`'s leaves the live side CORROBORATES, or `undefined` the
 * moment one of them CONTRADICTS it.
 *
 * A WILDCARD leaf (the caller's `wildcardLeaf` — the mask for the mask walk,
 * a whole token or the mask for the token walk) contributes 0 and is never
 * compared: it is the value being paired FOR, so requiring it to match would
 * refuse every array {@link pairedLiveItems} exists to align. Everything else
 * must agree — including the container SHAPE around it, since a subtree of a
 * different shape is a contradiction rather than an absent comparison.
 *
 * A COUNT rather than a boolean, because "nothing contradicted me" is exactly
 * the answer an all-wildcard array gives and it is not evidence. The caller
 * requires a non-zero count before it reads the order as corroborated.
 */
function corroboratedLeafCount(
  send: unknown,
  live: unknown,
  wildcardLeaf: (leaf: unknown) => boolean = isMaskLeaf
): number | undefined {
  if (wildcardLeaf(send)) return 0;
  if (Array.isArray(send)) {
    if (!Array.isArray(live) || live.length !== send.length) return undefined;
    let total = 0;
    for (let i = 0; i < send.length; i++) {
      const corroborated = corroboratedLeafCount(send[i], live[i], wildcardLeaf);
      if (corroborated === undefined) return undefined;
      total += corroborated;
    }
    return total;
  }
  if (isPlainRecord(send)) {
    // A non-plain object (`Date`, `Map`, `Set`, a class instance) on EITHER
    // side is a CONTRADICTION, never an abstention: its own enumerable keys
    // are `[]`, so the walk below would count two differing `Date`s as "no
    // contradiction" and let an unrelated sibling leaf corroborate the
    // pairing — the #2869 flattening's corroboration twin (see
    // {@link hasPlainPrototype}).
    if (!hasPlainPrototype(send)) return undefined;
    if (!isPlainRecord(live) || !hasPlainPrototype(live)) return undefined;
    const keys = Object.keys(send);
    if (keys.length !== Object.keys(live).length) return undefined;
    let total = 0;
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(live, k)) return undefined;
      const corroborated = corroboratedLeafCount(send[k], live[k], wildcardLeaf);
      if (corroborated === undefined) return undefined;
      total += corroborated;
    }
    return total;
  }
  return deepEqualUnordered(send, live) ? 1 : undefined;
}

/**
 * Send AWS's OWN value at every uncertified-baseline position (issue
 * [#3595](https://github.com/go-to-k/cdkd/issues/3595)).
 *
 * Detection split those positions off because the baseline's `***` was the
 * only difference there, so there is nothing to revert at them. But
 * {@link buildRevertNewProperties} overlays whole TOP-LEVEL keys: a real change
 * elsewhere under the same key carries the baseline subtree — masks included —
 * into the send bag, and {@link preserveLiveValuesAtMaskedLeaves} then cannot
 * pair an anchor-less list and refuses the whole resource. Detection already
 * certified the alignment ({@link equalModuloMask} held on these very
 * positions), so the live subtree is copied in wholesale.
 *
 * Every live value standing where the baseline held the mask is registered as
 * a mask-only needle ({@link recordMaskOnlyLiveSubtree}: its strings, its keys
 * the record does not spell, a number or boolean by its spelling) — at EVERY
 * uncertified path, overlaid or not — as the mask
 * walk does for the leaves it copies: the value cdkd could not name may be a
 * secret, and the send bag is what the provider's log lines see. Registration
 * is POSITIONAL where the two sides line up, and covers every live string under
 * the path where they do not (over-masking fails safe). It is only the OVERLAY
 * that leaves a non-aligned path untouched, so the mask walk after this one
 * still refuses rather than guesses. The #1644 narrowing write does not rely on
 * the needles alone: {@link keepBaselineAtUncertifiedPaths} keeps the masked
 * baseline value at these paths whatever the value's length.
 */
export function overlayLiveAtUncertifiedPaths(
  send: Record<string, unknown>,
  uncertifiedPaths: readonly string[],
  awsProperties: Record<string, unknown>,
  baseline: Record<string, unknown>,
  secrets: RecordedSecretValues,
  overlaidTopLevelKeys: ReadonlySet<string>,
  // The keys the record spells ({@link spelledKeysOf}); a live KEY among them
  // is not registered. Absent: every key is (over-masking fails safe).
  spelledKeys?: ReadonlySet<string>
): Record<string, unknown> {
  if (uncertifiedPaths.length === 0) return send;
  let out = send;
  for (const path of uncertifiedPaths) {
    const live = getAtPath(awsProperties, path);
    const masked = getAtPath(baseline, path);
    const aligned = live !== undefined && equalModuloMask(masked, live, SECRET_MASK);
    // A top-level key no kept change touches already holds AWS's value in the
    // send bag (`buildRevertNewProperties` copies it from the snapshot), so
    // there is nothing to OVERLAY there — but its live values still reach the
    // provider, whose echo the #1644 narrowing write persists into the
    // baseline. With nothing registered, a value today's resolution cannot
    // name (a rotated-away or edited secret) would be written into
    // `state.json` verbatim: the value scan has no needle for it and the
    // position source holds `***`, not a reference, so the fail-closed walk
    // never fires there. So REGISTRATION runs for every uncertified path;
    // only the overlay is limited to the keys a kept change carried in.
    if (!aligned) {
      // No alignment to register by position, so register every live string
      // under the path: over-masking fails safe, and for an overlaid key the
      // mask walk after this one still refuses rather than guesses.
      if (live !== undefined) recordMaskOnlyLiveSubtree(live, secrets, spelledKeys);
      continue;
    }
    const needles: string[] = [];
    const collect = (b: unknown, l: unknown): void => {
      if (b === SECRET_MASK) {
        // A mask matches any live value since go-to-k/cdkd#5333 (a definition
        // whose KEY held a secret is masked whole), so a CONTAINER here is
        // aligned too: what it holds, keys included, must reach the masker.
        if (typeof l === 'string') needles.push(l);
        else recordMaskOnlyLiveSubtree(l, secrets, spelledKeys);
        return;
      }
      if (Array.isArray(b) && Array.isArray(l)) {
        b.forEach((item, i) => collect(item, l[i]));
        return;
      }
      if (b !== null && typeof b === 'object' && l !== null && typeof l === 'object') {
        for (const key of Object.keys(b)) {
          if (hasOwnKey(l, key)) {
            collect(
              (b as Record<string, unknown>)[key],
              ownValue(l as Record<string, unknown>, key)
            );
          }
        }
      }
    };
    collect(masked, live);
    for (const needle of needles) recordMaskOnlyValue(secrets, needle);
    const topLevelKey = path.split('.', 1)[0] ?? '';
    if (overlaidTopLevelKeys.has(topLevelKey)) out = withValueAtPath(out, path, live);
  }
  return out;
}

/**
 * Register every string leaf, and every object KEY the record does not spell,
 * of a live value cdkd could not name as a mask-only needle
 * (go-to-k/cdkd#5342); a number or boolean live value by its spelling.
 * `recordMaskOnlyValuesIn` walks values only, and a Step Functions state NAMED
 * by a secret is a key, which a provider's validation error echoes
 * (`at /States/<name>`).
 */
function recordMaskOnlyLiveSubtree(
  live: unknown,
  secrets: RecordedSecretValues,
  spelledKeys?: ReadonlySet<string>
): void {
  // A NUMBER / BOOLEAN standing where the mask was: a secret substituted
  // outside quotes (go-to-k/cdkd#5315) reads back as one. Its spelling is the
  // needle; the mask-only floor still applies.
  if (typeof live === 'number' || typeof live === 'boolean') {
    recordMaskOnlyValue(secrets, String(live));
    return;
  }
  recordMaskOnlyValuesIn(live, secrets);
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (spelledKeys?.has(key) !== true) recordMaskOnlyValue(secrets, key);
      walk(value);
    }
  };
  walk(live);
}

/**
 * Put the BASELINE's own value back at every uncertified-baseline path of a
 * #1644 narrowing delta (issue [#3595](https://github.com/go-to-k/cdkd/issues/3595)).
 *
 * The delta is the provider's echo of what it delivered, and at such a path
 * that is a live value cdkd could not name: the position source holds `***`
 * rather than a reference, so the fail-closed walk never fires there, and a
 * needle shorter than the substitution floor is never registered. Keeping the
 * masked baseline value there persists nothing new — the position was unknown
 * before the revert and stays unknown — whatever the value's length. A path
 * the delta does not reach (its top-level key was not narrowed, or was
 * dropped) is left alone. The WHOLE baseline subtree comes back, so a real
 * narrowing of an unmasked neighbour inside it is undone too; the next run
 * then reports that as drift (the comparison is shape-strict), which is the
 * safe side of persisting a value cdkd cannot name.
 */
export function keepBaselineAtUncertifiedPaths(
  delta: Record<string, unknown>,
  uncertifiedPaths: readonly string[],
  baseline: Record<string, unknown>
): Record<string, unknown> {
  let out = delta;
  for (const path of uncertifiedPaths) {
    // Only where the delta HOLDS a value at the path. A key the provider
    // DROPPED is an own key holding `undefined`, which the write loop turns
    // into a delete — restoring over it would resurrect a key AWS no longer
    // has, and a drop persists no value to protect.
    if (getAtPath(out, path) === undefined) continue;
    const kept = getAtPath(baseline, path);
    if (kept === undefined) continue;
    out = withValueAtPath(out, path, kept);
  }
  return out;
}

/**
 * `bag` with `value` at the dotted `path`, rebuilding each ancestor rather than
 * writing into it, so the caller's bag — shared with the detection outcome —
 * is never mutated. Own keys throughout, for `getAtPath`'s reason. A path whose
 * ancestor is not a plain object returns `bag` unchanged.
 */
function withValueAtPath(
  bag: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return bag;
  // A plain `{}` (the bag goes to `provider.update`), keyed through
  // `defineOwnKey` so an own `__proto__` key stays a key.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) defineOwnKey(out, k, v);
  if (rest.length === 0) {
    defineOwnKey(out, head, value);
    return out;
  }
  const child = hasOwnKey(bag, head) ? ownValue(bag, head) : undefined;
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return bag;
  if (!hasPlainPrototype(child)) return bag;
  defineOwnKey(out, head, withValueAtPath(child as Record<string, unknown>, rest.join('.'), value));
  return out;
}

/**
 * Keep `cdkd drift --revert` from pushing a REDACTION MASK to AWS (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * WHY THIS EXISTS AT ALL. A `NoEcho` custom resource's `Data` resolved into a
 * dependent's property is persisted as {@link SECRET_MASK}, because there is no
 * expression to store in its place. So is the `Fn::Base64` encoding of a
 * secret (issues #2759 / #3119), and `observedProperties` holds one wherever
 * the #2852 walk could not certify a readback position. `--revert` pushes the BASELINE to AWS, so
 * without this a revert triggered by a SIBLING key would write the literal
 * `***` onto the live SSM parameter / secret / env var — the issue #1498 /
 * #1501 data-corruption class, and strictly worse than the disclosure the mask
 * exists to prevent. Shipping the mask without this guard would trade one for
 * the other.
 *
 * The sibling of {@link preserveLiveValuesAtUnresolvedTokens} and deliberately
 * a SEPARATE function rather than another branch inside it. That one is gated
 * on `unresolvedTokens.size > 0` at its call site, and this hazard is decided
 * by the SEND bag alone — a resource can carry a mask with no unresolved token
 * anywhere, so folding the two would put this check behind a condition that has
 * nothing to do with it.
 *
 * IT REGISTERS WHAT IT MOVES, exactly as the sibling does, and an earlier
 * revision's reason for not doing so was wrong: it said "the live value is one
 * cdkd never resolved and cannot recognise, so there is no needle to record".
 * The needle is `liveValue -> {@link SECRET_MASK}`, i.e. a MASK-ONLY entry, and
 * the evidence for it is the position — the masked position proves the value
 * is ONE CDKD CHOSE TO MASK, since nothing but this module's own redaction
 * puts a mask at a leaf. That is deliberately weaker than "proof the value is
 * secret" (issue #2881): a #2852 fail-closed mask deliberately over-masks a
 * value the walk merely could not certify — a normalised `US-EAST-1` as
 * readily as a credential — so the live value registered here may be an
 * ordinary literal. The consequence is bounded to over-masking log output,
 * the safe direction, and registering it is still right: when the position
 * DOES hold a secret, the registration is what keeps the moved plaintext out
 * of every reader below. Without it this function copies live plaintext into the
 * send bag and then `collectNarrowedTopLevelKeys` persists that delta into
 * `observedProperties` against a `secrets` map holding no entry for it — the
 * same disclosure the mask exists to prevent, arriving through the mechanism
 * that is supposed to protect it — and the same omission un-masks it in
 * `maskSecretsInText(err.message, secrets)` and in the masker handed to
 * `provider.update`.
 *
 * `secrets` is therefore MUTATED, which is why it is a parameter rather than
 * something the caller could omit. `recordMaskOnlyValue` applies its own
 * refusals (an entry that already carries a real EXPRESSION wins; a plaintext
 * below the needle floor is not recorded), so this call site states only the
 * position fact and lets the module decide what is registrable.
 *
 * TWO OUTCOMES per masked leaf, and the second is why this returns a report
 * rather than just a bag:
 *
 * - AWS holds a value there -> copy the LIVE value in. The revert then leaves
 *   that position exactly as AWS has it while still reverting every other
 *   drifted key, which is the same trade `preserveLiveValuesAtUnresolvedTokens`
 *   makes.
 * - AWS holds nothing there (the position could not be aligned, or the key is
 *   absent live) -> there is no safe value to send, so the path is reported as
 *   UNPRESERVABLE and the caller refuses the whole resource. Sending the mask
 *   would be the corruption; dropping the key would delete a property the
 *   resource may require.
 *
 * Array descent is NOT positional and does NOT bail on a length mismatch —
 * {@link pairedLiveItems} owns that question, for BOTH walks since issue
 * #2893 (the sibling's earlier answer, index alignment behind a length test,
 * was wrong by construction on the population that produces these masks, and
 * wrong under any reordered readback for the sibling's own tokens). An
 * earlier revision of this paragraph still claimed the sibling's rule after
 * the pairing had changed underneath it.
 *
 * `corroborationSource` is the bag the PAIRING EVIDENCE is read from, and it
 * exists because of a round-4 #2884 defect: `runRevert` runs
 * {@link preserveLiveValuesAtUnresolvedTokens} FIRST, and that pass copies
 * `live` values into whole-token leaves — BY INDEX when the defect was found;
 * by certified pairing since issue #2893, which does not retire this
 * parameter, because a copied leaf is trivially deep-equal to `live` at its
 * own position HOWEVER it was chosen, so corroborating `send` (the post-token
 * bag) against that same `live` still counts evidence a sibling pass
 * manufactured rather than evidence AWS's readback supplied. Under the
 * original index copies, an unkeyed array
 * whose only non-mask leaves were tokens satisfied both the
 * `compared > 0` floor and the one-mask bound on evidence the sibling pass
 * manufactured, and a reordered `live` wrote another element's secret into the
 * masked slot — the credential-swap class the guards were added for. The same
 * fabrication reached the IDENTITY arm: an identity field that was itself a
 * token took its live value by index, and {@link pairedLiveItems}' keyed
 * lookup then "paired" it right back to that index. So the caller passes the
 * PRE-token bag here; both the identity lookup and the per-leaf corroboration
 * run over values no sibling pass copied from `live`, a token leaf compares
 * against the resolved live value and CONTRADICTS (its live counterpart is
 * unknowable, and an abstention would make token leaves unbounded wildcards
 * beside the deliberately bounded one-mask rule), and the array refuses. The
 * masked VALUES the walk writes still come from `send` — only the evidence
 * source changes. Defaults to `send` (self-corroboration, the pre-round-4
 * behaviour) for a caller with no sibling pass; a structural mismatch between
 * the two bags refuses the masks beneath it rather than falling back to the
 * fabricable bag. Until issue #2920 the token pass COULD produce one, by
 * returning the live CONTAINER AWS holds over a whole-token string leaf; it
 * now copies only a string, so no sibling pass produces the mismatch today.
 * The refusal is KEPT as a deliberate fail-closed cost rather than retired on
 * that reachability argument: a bag that disagrees with its evidence source is
 * exactly where falling back would hand the fabricable bag back.
 *
 * Returns the input bag BY IDENTITY when it holds no mask — checked FIRST via
 * {@link carriesSecretMask}, so a mask-free revert (the ordinary case) pays
 * one boolean walk instead of a full rebuild plus per-array pairing.
 */
export function preserveLiveValuesAtMaskedLeaves(
  send: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  secrets: RecordedSecretValues,
  corroborationSource: Record<string, unknown> = send,
  spelledKeys?: ReadonlySet<string>
): { properties: Record<string, unknown>; unpreservablePaths: string[] } {
  if (!carriesSecretMask(send)) return { properties: send, unpreservablePaths: [] };
  const unpreservablePaths: string[] = [];
  let changed = false;
  const walk = (value: unknown, corr: unknown, live: unknown, path: string): unknown => {
    if (value === SECRET_MASK) {
      if (live === undefined) {
        unpreservablePaths.push(path);
        return value;
      }
      changed = true;
      // REGISTER before returning — see the note above: a string by itself, a
      // container by its strings and the keys the record does not spell, a
      // number or boolean by its spelling (go-to-k/cdkd#5342).
      if (typeof live === 'string') recordMaskOnlyValue(secrets, live);
      else recordMaskOnlyLiveSubtree(live, secrets, spelledKeys);
      return live;
    }
    if (Array.isArray(value)) {
      // Pairing evidence comes from `corr` — see `corroborationSource` above.
      // In the self-corroboration default `corr` IS `value`, so this test
      // always passes there. A provided source of any other shape is REFUSED,
      // not fallen back from. Until issue #2920 the mismatch was producible
      // (the token pass returned `live` untyped at a whole-token leaf, so a
      // string in `corr` could sit where `value` held the container AWS
      // reported); the token pass now copies only a string, so nothing
      // produces it today. Kept as a deliberate fail-closed cost: falling back
      // to `value` would hand the fabricable bag back exactly where the two
      // bags disagree.
      const corrItems =
        Array.isArray(corr) && corr.length === value.length
          ? (corr as readonly unknown[])
          : undefined;
      const liveItems = corrItems === undefined ? undefined : pairedLiveItems(corrItems, live);
      return value.map((item, i) => walk(item, corrItems?.[i], liveItems?.[i], `${path}[${i}]`));
    }
    if (value !== null && typeof value === 'object') {
      // A non-plain object is a LEAF returned BY IDENTITY — same guard and
      // same reason as the token pass's object arm above: rebuilding a `Date`
      // / `Uint8Array` / class instance through `Object.entries` fabricates
      // `{}` (or an index map) into the bag `provider.update` ships, and the
      // raw SDK readback genuinely reaches this walk through
      // `buildRevertNewProperties`.
      if (!hasPlainPrototype(value)) {
        // ENFORCED, not asserted: `carriesSecretMask` descends ANY object via
        // `Object.values`, so a mask nested inside a non-plain container is
        // reachable to the GATE while this walk stops here — and returning
        // silently would ship the literal `***` to AWS unreported, the
        // fail-open half of exactly the gate/walk asymmetry class. No shape
        // reaches this today (this module writes masks only at string leaves
        // of plain containers), but the day one does, the resource is
        // REFUSED, not corrupted.
        if (carriesSecretMask(value)) unpreservablePaths.push(path);
        return value;
      }
      const liveObject = isPlainRecord(live) ? live : undefined;
      const corrObject = isPlainRecord(corr) ? corr : undefined;
      // `Object.create(null)`: an own `__proto__` key (producible —
      // `JSON.parse` on state.json yields one as an OWN key) assigned onto a
      // `{}` literal SETS the prototype and silently drops the key; a
      // null-prototype target takes it as the ordinary own key it is. Same
      // rule and reason as `secret-redaction.ts`'s rebuild sites.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(
          v,
          corrObject === undefined ? undefined : ownValue(corrObject, k),
          liveObject === undefined ? undefined : ownValue(liveObject, k),
          path === '' ? k : `${path}.${k}`
        );
      }
      return out;
    }
    return value;
  };
  const properties = walk(send, corroborationSource, awsProperties, '') as Record<string, unknown>;
  if (!changed && unpreservablePaths.length === 0) return { properties: send, unpreservablePaths };
  return { properties, unpreservablePaths };
}
