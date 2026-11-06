/**
 * `cdkd drift`: `--revert` payload assembly and the narrowed-key helpers.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { getLogger } from '../../../utils/logger.js';
import type { PropertyDrift } from '../../../analyzer/drift-calculator.js';
import { hasOwnKey, ownValue, defineOwnKey, hasPlainPrototype } from '../../../utils/own-keys.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { carriesSecretMask } from '../../../deployment/secret-redaction.js';
import type { ResourceProvider } from '../../../types/resource.js';
import {
  mergeUntemplatedValue,
  isCfnTagList,
  isTagListKey,
  mergeTagListForRevert,
  isPlainRecord,
} from './revert-merge.js';

/**
 * Build the `newProperties` object passed to `provider.update` during
 * `--revert`. Strategy:
 *
 *   1. Start from `awsProperties` (the AWS-current snapshot returned
 *      by `readCurrentState`, which `runRevert` already passes as the
 *      `previousProperties` argument to `provider.update`).
 *   2. For every top-level key whose subtree contains a drifted path,
 *      overwrite it with the corresponding sub-shape from
 *      `desiredProperties` (the state-recorded `observedProperties`).
 *
 * Why "AWS-current base + drifted overlay" instead of "drifted-only
 * partial":
 *
 *   Several providers' `update()` implementations diff
 *   `newProperties[K]` against `previousProperties[K]` and treat
 *   `newVal === undefined` as "remove K from AWS" (e.g.
 *   `SNSTopicProvider` calls `SetTopicAttributes(K, '')`,
 *   `IAMRoleProvider.updateManagedPolicies` detaches every previously
 *   attached policy when the new arg is undefined). Passing a
 *   drifted-only partial would silently clear non-drifted attributes
 *   on those providers. Sending the AWS-current value back as the
 *   "new" value for non-drifted keys keeps `JSON.stringify(newVal) ===
 *   JSON.stringify(oldVal)` so the diff is a no-op — no provider
 *   changes required.
 *
 *   For non-diff providers (e.g. `SQSQueueProvider` blindly pushes
 *   every defined key via `SetQueueAttributes`), the AWS-current
 *   value still gets serialised back to the same string AWS already
 *   has, so the round-trip is a no-op for the AWS resource state.
 *   The one exception is `readCurrentState`'s always-emit
 *   placeholder values — e.g. SQS `RedrivePolicy: {}` — which AWS
 *   rejects as invalid input even though they're round-tripped. That
 *   class of value (Class 2 / structurally-incomplete-when-empty) is
 *   handled by per-provider sanitize at the wire-layer; see the SQS
 *   provider's `serializeRedrivePolicy` helper for the canonical
 *   pattern.
 *
 * The drift comparator never produces array-index segments
 * (`Tags[0].Value`) — array drifts surface as a single entry on the
 * parent path — so `path.split('.', 1)` is always safe to extract the
 * top-level key.
 *
 * `preserveUntemplated` (issue #1626) switches the overlay from WHOLESALE to a
 * deep merge for the drifted subtrees, keeping every path the baseline does
 * not declare. `runRevert` sets it exactly when the resource has no
 * `observedProperties` — see {@link mergeUntemplatedValue} for why that is the
 * only baseline on which it is correct, and why the fix has to live on this
 * side rather than on `previousProperties`.
 *
 * `absentMeansDefault` (go-to-k/cdkd#5399) names the drifted top-level keys
 * the baseline records at their default by leaving them out (see
 * {@link driftAbsentMeansDefaultKeys}). Such a key is sent ABSENT instead of
 * keeping the AWS value, so the provider's `update()` resets it the way it
 * resets a property a template removed.
 */
export function buildRevertNewProperties(
  drifts: readonly PropertyDrift[],
  desiredProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  options: { preserveUntemplated?: boolean; absentMeansDefault?: readonly string[] } = {}
): Record<string, unknown> {
  const preserveUntemplated = options.preserveUntemplated === true;
  const absentMeansDefault = options.absentMeansDefault ?? [];
  // A plain spread on purpose (every provider receives this bag, and spread
  // defines an own `__proto__` key correctly); the overlays below go through
  // `defineOwnKey` because a top-level drift at a key literally named
  // `__proto__` (issue #2899's class — `JSON.parse`d state yields one as an
  // ordinary own key) ASSIGNED onto this plain object would set its prototype
  // and drop the reverted member from the payload.
  const result: Record<string, unknown> = { ...awsProperties };
  for (const d of drifts) {
    const topLevelKey = d.path.split('.', 1)[0];
    if (!topLevelKey) continue;
    if (hasOwnKey(desiredProperties, topLevelKey)) {
      const desiredValue = desiredProperties[topLevelKey];
      // Own key only: on a plain AWS bag a bare `['__proto__']` read for a key
      // it does not own answers `Object.prototype`, not "absent".
      const awsValue = ownValue(awsProperties, topLevelKey);
      // A TAG LIST keeps its AWS-service-authored entries instead of being
      // overwritten wholesale (issue #1501). See `mergeTagListForRevert`.
      //
      // The baseline side accepts an EMPTY array as well as a populated tag
      // list: a template that DECLARES `Tags` with a condition-collapsed or
      // empty list still has an AWS side worth diffing against, and treating
      // that as "nothing to diff" would strip `AmazonECSManaged` — the exact
      // failure this carve-out exists to prevent. (The #1498 rule covers the
      // commoner UNDECLARED + captured-empty shape by ignoring the key
      // outright, so it never reaches here.)
      if (preserveUntemplated) {
        // Issue #1626: on a raw-TEMPLATE baseline every untemplated path is
        // kept, which is a strict SUPERSET of the #1501 tag carve-out (that
        // one keeps only service-authored entries), so it subsumes the branch
        // below rather than competing with it. The superset holds for a
        // DECLARED-but-EMPTY baseline list too — see the note in
        // `mergeUntemplatedValue`, which is where that shape is handled.
        defineOwnKey(result, topLevelKey, mergeUntemplatedValue(awsValue, desiredValue));
      } else {
        const baselineIsTagList =
          isCfnTagList(desiredValue) || (Array.isArray(desiredValue) && desiredValue.length === 0);
        defineOwnKey(
          result,
          topLevelKey,
          isTagListKey(topLevelKey) && baselineIsTagList && isCfnTagList(awsValue)
            ? mergeTagListForRevert(desiredValue as Array<Record<string, unknown>>, awsValue)
            : desiredValue
        );
      }
    } else if (absentMeansDefault.includes(topLevelKey)) {
      // go-to-k/cdkd#5399: the baseline recorded this key at its default by
      // omitting it, so the revert sends it absent and `update()` resets it.
      delete result[topLevelKey];
    } else {
      // Drift surfaced on a key that's no longer in `desiredProperties`
      // (defensive — drift was computed against `desiredProperties`, so
      // this only happens if state mutated between drift read and now).
      // Fall through to whatever `awsProperties[topLevelKey]` was.
    }
  }
  return result;
}

/**
 * The provider's {@link ResourceProvider.getDriftAbsentMeansDefaultKeys} for
 * this record (go-to-k/cdkd#5399), or none. `properties` is the record's
 * template intent. A record whose `properties` is not a plain object (a
 * malformed state file) names no key: to the hook, `{}` would read as a
 * template on the default, which licenses resetting the live value.
 */
export function driftAbsentMeansDefaultKeys(
  provider: Pick<ResourceProvider, 'getDriftAbsentMeansDefaultKeys'>,
  resourceType: string,
  properties: unknown
): readonly string[] {
  if (provider.getDriftAbsentMeansDefaultKeys === undefined || !isPlainRecord(properties)) {
    return [];
  }
  const keys = provider.getDriftAbsentMeansDefaultKeys(resourceType, properties);
  // The contract is top-level property names: a dotted path would match no
  // top-level key on either path and silently do nothing, so it is dropped
  // where a provider author can see it.
  const dotted = keys.filter((key) => key.includes('.'));
  if (dotted.length === 0) return keys;
  getLogger().debug(
    safeMsg`${resourceType}: getDriftAbsentMeansDefaultKeys returned non-top-level name(s) ` +
      safeMsg`${dotted.join(', ')}; ignored (top-level property names only).`
  );
  return keys.filter((key) => !key.includes('.'));
}

/**
 * The comparison baseline with each of `keys` the baseline lacks and the AWS
 * side holds added as an own `undefined`, so the comparator's baseline-keys
 * top-level walk compares it (go-to-k/cdkd#5399). The input by identity when
 * no key applies, and a copy otherwise, so no other reader of the baseline
 * sees the added key.
 */
export function withAbsentDefaultKeys(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const missing = keys.filter((key) => !hasOwnKey(baseline, key) && hasOwnKey(aws, key));
  if (missing.length === 0) return baseline;
  const out: Record<string, unknown> = { ...baseline };
  for (const key of missing) defineOwnKey(out, key, undefined);
  return out;
}

/**
 * The top-level keys a provider NARROWED on the revert path (issue #1644).
 *
 * `provider.update()` may answer with `effectiveProperties` — the bag it
 * ACTUALLY delivered, which is what AWS now holds. `DeployEngine` records that
 * in place of the desired bag (`propertiesToRecord`), and `--revert` used to
 * throw the return value away: state kept the un-narrowed value, so the very
 * next `cdkd drift` reported the same difference and `--revert` re-issued the
 * same call — the loop `effectiveProperties` exists to break, still live on
 * this one command.
 *
 * Returns a per-key DELTA rather than the whole bag, and that is the load-
 * bearing part. The bag handed to `update()` here is
 * {@link buildRevertNewProperties}'s output — AWS-current values for every
 * non-drifted key merged with the state baseline for the drifted ones — so
 * writing it back wholesale would import AWS-authored values into state for
 * keys nobody reverted, quietly turning `--revert` into `--accept`. Only the
 * keys the PROVIDER changed between what it was handed and what it delivered
 * belong in state.
 *
 * A key present in `sent` but absent from `effective` is a DROP: the provider
 * did not deliver it, so AWS does not hold it, and the baseline must lose it
 * too. That is represented by an explicit `undefined` value, which the caller
 * turns into a `delete` — a plain `{...baseline, ...delta}` spread would leave
 * an `undefined`-valued key in the JSON instead. Presence is decided by
 * OWN-key membership in `effective`, NOT by comparing against `undefined`: a provider that
 * delivers an explicit `undefined` and one that omits the key both mean "AWS
 * does not hold it", while a key whose value genuinely IS `null` on both sides
 * must not read as a drop.
 *
 * The comparison is a key-order-INDEPENDENT deep equality rather than
 * `JSON.stringify`. A provider that rebuilds a nested object while delivering
 * the same members would otherwise register as a change, and the value written
 * back for such a key is the one that was SENT — for a non-drifted key that is
 * the AWS-current value, i.e. the `--accept` behavior this delta exists to
 * prevent.
 */
export function collectNarrowedTopLevelKeys(
  sent: Record<string, unknown>,
  effective: Record<string, unknown>
): Record<string, unknown> {
  // `Object.create(null)` (issue #2899's class): `sent` is the preserve
  // walks' null-prototype rebuild of a `JSON.parse`d baseline, so an own
  // `__proto__` key is enumerated here like any other — assigned onto a `{}`
  // literal it would set the delta's prototype and drop the narrowing.
  const delta: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(sent), ...Object.keys(effective)])) {
    // OWN keys (PR #3124 review): `sent` is the preserve walks' null-prototype
    // rebuild and may own `__proto__`; `effective` is a provider's plain bag,
    // where `'__proto__' in effective` is `true` through the chain and the
    // delta would record `Object.prototype` as the "effective value" instead
    // of the drop it really is.
    const inSent = hasOwnKey(sent, key);
    const inEffective = hasOwnKey(effective, key);
    if (inSent && inEffective && deepEqualUnordered(sent[key], effective[key])) continue;
    if (!inSent && !inEffective) continue;
    delta[key] = inEffective ? effective[key] : undefined;
  }
  return delta;
}

/**
 * Deep equality that does not depend on object key ORDER.
 *
 * A NON-PLAIN object (`Date`, `Uint8Array`, `Map`, a class instance) on either
 * side compares UNEQUAL unless it is the same object (issue
 * [#2897](https://github.com/go-to-k/cdkd/issues/2897)): its own enumerable
 * keys are `[]`, so the key walk below reported any two `Date`s equal —
 * `0 === 0` — which HID a narrowing in {@link collectNarrowedTopLevelKeys}
 * (the changed value never reached `observedProperties`, leaving the baseline
 * stale there) and SUPPRESSED `runAccept`'s "was NOT recorded" warning. Same
 * guard, same reason as `secret-redaction.ts`'s `deepEqualJsonValue` and the
 * corroboration count above. Reachable: `sent` descends from
 * `buildRevertNewProperties`, which copies `readCurrentState`'s RAW SDK return
 * with no JSON round-trip, and `effective` is a provider's own echo. The
 * direction is deliberate — a value cdkd cannot compare is a value it must not
 * call unchanged, and for the narrowing that means the provider's echo is
 * recorded (the truthful answer) rather than silently kept stale.
 */
export function deepEqualUnordered(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualUnordered(v, b[i]));
  }
  if (!hasPlainPrototype(a) || !hasPlainPrototype(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqualUnordered(ao[k], bo[k])
  );
}

/**
 * The redacted attributes a `--revert` records (go-to-k/cdkd#4476), with each
 * top-level key the value scan masked put back to the RECORDED value when the
 * plaintext it masked is exactly that value.
 *
 * The scan runs over the revert's whole per-resource `secrets` map, which also
 * holds the deliberately over-broad mask-only needles of the uncertified-path
 * and masked-leaf overlays (every live string under such a path). Those are
 * safe for the narrowing write, which `keepBaselineAtUncertifiedPaths` repairs,
 * but here they would mask an unrelated identity value (a queue name equal to a
 * tag value) and persist `***` over it. Keeping a value `state.json` already
 * holds in the clear discloses nothing new; a key whose plaintext CHANGED stays
 * masked, which fails safe.
 */
export function keepRecordedAttributesOverMask(
  redacted: Record<string, unknown>,
  plaintext: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  noEchoDeclared: true | Set<string> | undefined
): Record<string, unknown> {
  // A key the provider DECLARED `NoEcho` is masked on purpose, as a deploy
  // would mask it, even where an older record holds it in the clear.
  if (recorded === undefined || noEchoDeclared === true) return redacted;
  const out: Record<string, unknown> = { ...redacted };
  for (const key of Object.keys(redacted)) {
    if (noEchoDeclared?.has(key)) continue;
    if (!hasOwnKey(recorded, key) || !carriesSecretMask(redacted[key])) continue;
    if (carriesSecretMask(recorded[key])) continue;
    if (sameRecordedJson(plaintext[key], recorded[key])) {
      defineOwnKey(out, key, recorded[key]);
    }
  }
  return out;
}

/**
 * Equality between a value about to be persisted and the one `state.json`
 * holds: the candidate goes through the JSON round-trip the write applies
 * (an `undefined` member is dropped), then compares ignoring key order.
 */
export function sameRecordedJson(candidate: unknown, recorded: unknown): boolean {
  const persisted: unknown =
    candidate === undefined ? undefined : JSON.parse(JSON.stringify(candidate));
  return deepEqualUnordered(persisted, recorded);
}
