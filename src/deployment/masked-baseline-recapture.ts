import { isDeepStrictEqual } from 'node:util';
import {
  carriesSecretMask,
  dynamicReferenceTokens,
  mergeResolvedPairs,
  redactSecretsForState,
  SECRET_MASK,
  spanNamesResolvableService,
  STATE_SOURCED_BASELINE_RULES,
  wholeStringLeavesOf,
  type RecordedSecretValues,
} from './secret-redaction.js';
import type { ResourceState } from '../types/state.js';
import type { ResolverContext } from './intrinsic-function-resolver.js';

/**
 * The deploy-start re-capture of an `observedProperties` baseline that holds a
 * #2852 fail-closed mask (issue [#3595](https://github.com/go-to-k/cdkd/issues/3595)).
 *
 * A NO_CHANGE resource is never resolved during a deploy, so its readback is
 * redacted with an EMPTY secrets map, and a position the walk cannot pair (two
 * indistinguishable bare references in one unkeyed list, an identity key AWS
 * normalised) fails closed to `***`. Nothing ever re-captured such a baseline
 * short of a deploy that changed the resource. This module lets the
 * deploy-start auto-refresh clear exactly those positions, using a secrets map
 * resolved from the record's OWN `properties`.
 *
 * THE CONTRACT, which is what makes the re-capture safe to run on every deploy:
 *
 * - **Only a masked position changes.** The result is the PREVIOUS baseline
 *   with some `***` leaves replaced; every other leaf stays byte-identical. A
 *   replacement is taken only when it is one of the record's own secret
 *   expressions, or a whole string leaf of the record's `properties` that
 *   carries one — never a value AWS returned. So the result holds no string
 *   that the previous baseline or `properties` did not already hold.
 * - **No drift at an unmasked position is absorbed, and the resource is the
 *   one the baseline describes.** Every unmasked position is kept, so a
 *   drifted one stays in the baseline for `cdkd drift` to report. A masked
 *   position recorded nothing, so a value changed there since the baseline was
 *   taken (two masked values swapped out of band, say) is certified as AWS
 *   holds it now; no known value is lost. On top of that the fresh readback,
 *   redacted exactly as an ordinary capture would redact it (empty map,
 *   fail-closed rules), must REPRODUCE the previous baseline: equal everywhere,
 *   except that a position it masks may hold `***` or one of the record's own
 *   references in the baseline — the latter is what an earlier re-capture put
 *   there, and accepting it is what lets a later deploy clear the rest (a
 *   secret rotated back, say). Anything else means the resource changed since
 *   the baseline was taken, or another binary wrote that baseline, and the
 *   re-capture is refused.
 * - **A rotated secret stays masked.** The map holds TODAY's value; a readback
 *   still carrying yesterday's matches nothing, and the fail-closed walk masks
 *   it again. So does every position the map cannot pair.
 */

/**
 * Is this record one whose baseline the auto-refresh may try to re-capture?
 *
 * - its `observedProperties` hold a {@link SECRET_MASK};
 * - its `properties` hold NONE: a `NoEcho` custom-resource mask (issue #2274)
 *   is persisted into `properties` too, and no resolution can supply that
 *   value, so such a record is left entirely alone;
 * - its `properties` hold a reference of a service cdkd resolves, the only
 *   thing a resolved map can certify a position from;
 * - it is not an `observedBaselineRefused` record (issue #2944). Such a record
 *   has no `observedProperties` today, so the clause only states the rule the
 *   missing-baseline arm already applies.
 */
export function isMaskedBaselineRecaptureCandidate(record: ResourceState): boolean {
  if (record.observedBaselineRefused === true) return false;
  const observed = record.observedProperties;
  if (observed === undefined || !carriesSecretMask(observed)) return false;
  const properties = record.properties;
  if (carriesSecretMask(properties)) return false;
  return secretReferenceTokensOf(properties).length > 0;
}

/**
 * Every distinct complete `{{resolve:...}}` token of a service cdkd RESOLVES in
 * a bag's string leaves, in first-seen order. A token of any other service
 * records no pair, so it certifies nothing, and resolving it would print the
 * resolver's unsupported-service warning on every deploy.
 */
export function secretReferenceTokensOf(bag: unknown): string[] {
  const tokens = new Set<string>();
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (!node.includes('{{resolve:')) return;
      for (const token of dynamicReferenceTokens(node)) {
        if (spanNamesResolvableService(token)) tokens.add(token);
      }
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child);
  };
  walk(bag);
  return [...tokens];
}

/**
 * Resolve every reference the record's `properties` spell into a map of its
 * own. `resolveToken` resolves one token and records its pair into the map it
 * is handed, the way the resolver's persisted-text entry does.
 *
 * ALL OR NOTHING on a failure: returns `undefined` — and the caller keeps the
 * old baseline — when any token throws (an `ambiguous` region, a missing grant, a deleted secret), or when
 * two different references resolve to the same plaintext: the map is keyed by
 * plaintext, so it could only name one of them, and a position certified with
 * the other's expression would be a wrong reference in the baseline (the #1910
 * class). Each token gets its own map first so that a collision is visible.
 * A token that resolves without recording a pair (a public `ssm` parameter)
 * throws nothing and certifies nothing: its positions keep their masks.
 */
export async function resolveRecordSecrets(
  properties: Record<string, unknown>,
  resolveToken: (token: string, secrets: RecordedSecretValues) => Promise<unknown>
): Promise<RecordedSecretValues | undefined> {
  const secrets: RecordedSecretValues = new Map();
  for (const token of secretReferenceTokensOf(properties)) {
    const own: RecordedSecretValues = new Map();
    try {
      await resolveToken(token, own);
    } catch {
      return undefined;
    }
    for (const [plaintext, expression] of own) {
      const earlier = secrets.get(plaintext);
      if (earlier !== undefined && earlier !== expression) return undefined;
      secrets.set(plaintext, expression);
    }
    mergeResolvedPairs(own, secrets);
  }
  return secrets;
}

/**
 * The context one PERSISTED token is resolved in: no template and no
 * resources (the token is text read out of a state record, like `cdkd drift`'s
 * and the rollback replay's), the pass's own map, and the stack's producer
 * regions so the resolver's region classifier can refuse an `ambiguous`
 * reference. An empty region list is omitted, which the classifier reads the
 * same way.
 */
export function persistedTokenResolverContext(
  secrets: RecordedSecretValues,
  producerRegions: readonly string[]
): ResolverContext {
  return {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: secrets,
    ...(producerRegions.length > 0 && { producerRegions }),
  };
}

/**
 * Does `ordinary` — a fresh readback redacted as an ordinary capture would —
 * reproduce `previous`? Compared in PERSISTED form (a readback `Date` is its
 * ISO string; key order is not a difference). Where `ordinary` holds the mask,
 * `previous` may hold the mask or an `admissible` reference: see the contract
 * at the top of this module.
 */
function reproducesBaseline(
  ordinary: unknown,
  previous: unknown,
  admissible: ReadonlySet<string>
): boolean {
  const walk = (fresh: unknown, old: unknown): boolean => {
    if (fresh === SECRET_MASK) {
      return old === SECRET_MASK || (typeof old === 'string' && admissible.has(old));
    }
    if (Array.isArray(fresh)) {
      return (
        Array.isArray(old) && old.length === fresh.length && fresh.every((v, i) => walk(v, old[i]))
      );
    }
    if (fresh !== null && typeof fresh === 'object') {
      if (old === null || typeof old !== 'object' || Array.isArray(old)) return false;
      const freshKeys = Object.keys(fresh);
      const oldBag = old as Record<string, unknown>;
      return (
        freshKeys.length === Object.keys(oldBag).length &&
        freshKeys.every(
          (key) =>
            Object.hasOwn(oldBag, key) && walk((fresh as Record<string, unknown>)[key], oldBag[key])
        )
      );
    }
    return isDeepStrictEqual(fresh, old);
  };
  return walk(JSON.parse(JSON.stringify(ordinary)), JSON.parse(JSON.stringify(previous)));
}

/**
 * The re-captured baseline, or `undefined` when nothing may change.
 *
 * `previous` is the persisted baseline, `readback` a fresh
 * `readCurrentState` of the same resource, `properties` the record's own
 * (redacted) properties and `secrets` the map {@link resolveRecordSecrets}
 * built from them.
 */
export function recaptureMaskedBaseline(args: {
  previous: Record<string, unknown>;
  readback: Record<string, unknown>;
  properties: Record<string, unknown>;
  secrets: RecordedSecretValues;
}): Record<string, unknown> | undefined {
  const { previous, readback, properties, secrets } = args;
  // What a masked position may become: a reference the record's properties
  // spell, whole or as the leaf that embeds it. Taken from `properties`, not
  // from the map's values, so the result is bounded by what the record already
  // holds whatever the map says.
  const admissible = new Set<string>(secretReferenceTokensOf(properties));
  for (const leaf of wholeStringLeavesOf(properties)) {
    if (leaf.includes('{{resolve:')) admissible.add(leaf);
  }
  // What an ordinary capture persists today: nothing resolved, fail closed.
  //
  // The readback is NOT marked same-generation here, although the drain marks
  // the bag an ordinary capture installs. The mark is read only by the
  // embedded-span positioner, which needs a pair recorded in the pass's map:
  // there is none in this empty-map pass, and the populated pass below is read
  // only at positions this one masked, where the walk refused to position
  // anything. Marking would change no answer.
  const ordinary = redactSecretsForState(
    readback,
    new Map(),
    properties,
    STATE_SOURCED_BASELINE_RULES
  );
  if (!reproducesBaseline(ordinary, previous, admissible)) return undefined;
  // The same readback, with the record's own references resolved. Still the
  // fail-closed rules: a populated map is not evidence that every plaintext in
  // the readback is covered (a rotated secret is not in it).
  const certified = redactSecretsForState(
    readback,
    secrets,
    properties,
    STATE_SOURCED_BASELINE_RULES
  );
  let changed = false;
  const overlay = (old: unknown, fresh: unknown): unknown => {
    if (old === SECRET_MASK) {
      if (typeof fresh === 'string' && fresh !== SECRET_MASK && admissible.has(fresh)) {
        changed = true;
        return fresh;
      }
      return old;
    }
    if (Array.isArray(old)) {
      if (!Array.isArray(fresh) || fresh.length !== old.length) return old;
      let differs = false;
      const out = old.map((item, i) => {
        const next = overlay(item, fresh[i]);
        if (next !== item) differs = true;
        return next;
      });
      return differs ? out : old;
    }
    if (old !== null && typeof old === 'object') {
      if (fresh === null || typeof fresh !== 'object' || Array.isArray(fresh)) return old;
      const freshBag = fresh as Record<string, unknown>;
      let differs = false;
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries(old as Record<string, unknown>)) {
        const next = Object.hasOwn(freshBag, key) ? overlay(value, freshBag[key]) : value;
        if (next !== value) differs = true;
        out[key] = next;
      }
      return differs ? { ...out } : old;
    }
    return old;
  };
  const result = overlay(previous, certified) as Record<string, unknown>;
  return changed ? result : undefined;
}
