/**
 * `cdkd drift`: `--revert` merge helpers: tag lists, untemplated values, unresolved tokens.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import type { PropertyDrift } from '../../../analyzer/drift-calculator.js';
import { hasOwnKey, ownValue, hasPlainPrototype } from '../../../utils/own-keys.js';
import {
  type RecordedSecretValues,
  isSingleDynamicReferenceToken as isWholeDynamicReference,
  liveMatchesUnresolvedTokenFrame,
} from '../../../deployment/secret-redaction.js';
import { pairedLiveItems, isTokenOrMaskLeaf, carriesTokenOrMask } from './revert-live-values.js';

/**
 * A top-level property NAME that carries tags.
 *
 * The shape test below is deliberately NOT sufficient on its own: a top-level
 * `[{ Key, Value }]` list is not tag-exclusive — `LoadBalancerAttributes`,
 * `TargetGroupAttributes` and SSM `Association.Targets` all match it. No such
 * property can carry an `aws:`-prefixed or `AmazonECSManaged` key today, so the
 * carve-out would degrade to the identity of the old wholesale overwrite there
 * — but borrowing `canonicalizeTagListsDeep`'s heuristic for a WRITE decision
 * is not justified by its use for a SORT: a sort false positive is harmless, an
 * append is not.
 */
export function isTagListKey(key: string): boolean {
  return key === 'Tags' || key.endsWith('Tags');
}

/** A CFn-shaped tag list: a non-empty array whose every element has a string `Key`. */
export function isCfnTagList(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((t) => isPlainRecord(t) && typeof (t as { Key?: unknown }).Key === 'string')
  );
}

/** The `Key` of every entry in a CFn tag list, in list order. */
function tagKeys(tags: ReadonlyArray<Record<string, unknown>>): string[] {
  return tags.map((t) => t['Key'] as string);
}

/**
 * AWS-SERVICE-authored tag keys a `--revert` must not strip (issue #1501).
 *
 * `AmazonECSManaged` is attached by ECS when a capacity provider binds an Auto
 * Scaling group, and managed scaling stops working without it. That entry is
 * the load-bearing one.
 *
 * The `aws:` prefix is DEFENSIVE rather than load-bearing, and the distinction
 * is worth stating: AWS reserves the prefix and rejects a write of one, and the
 * 45 providers that route reads through `normalizeAwsTagsToCfn` strip such keys
 * on the way in — so an `aws:` key can only reach the AWS side of a comparison
 * via the Cloud Control `readCurrentState` path, which returns the raw model.
 * It costs nothing to honor and cdkd can never have authored one.
 */
const SERVICE_MANAGED_TAG_KEYS: ReadonlySet<string> = new Set(['AmazonECSManaged']);

/** Whether a tag key is AWS-service-authored, per {@link SERVICE_MANAGED_TAG_KEYS}. */
function isServiceManagedTagKey(key: string): boolean {
  return SERVICE_MANAGED_TAG_KEYS.has(key) || key.startsWith('aws:');
}

/**
 * Revert a TAG LIST, preserving AWS-SERVICE-authored entries (issue #1501).
 *
 * Everything in {@link buildRevertNewProperties} overwrites a drifted top-level
 * key wholesale, which for `Tags` means "AWS ends up with exactly the tags cdkd
 * state recorded" — so a service-authored tag added after deploy is stripped.
 * The concrete case: ECS attaches `AmazonECSManaged` to an ASG when a capacity
 * provider binds it, and that tag is REQUIRED for managed scaling. Because any
 * CDK ASG declares at least a `Name` tag, `Tags` is template-DECLARED, so the
 * #1498 carve-out (undeclared + captured-empty) correctly does not apply — and
 * the tag list is an ARRAY, which {@link findRevertUnbaselinedAwsKeys}'s walk
 * compares wholesale and never descends into. Post-revert the ASG kept the
 * capacity provider with its managed scaling silently broken (verified live
 * 2026-08-10).
 *
 * The semantic: the baseline still WINS for every ordinary tag — one it has and
 * AWS lost is re-added, one whose value differs is reset, and a
 * user/console-added tag AWS alone has is still REMOVED. Only a
 * {@link isServiceManagedTagKey} entry survives.
 *
 * **This is the issue's option 2, not its option 1, and the choice was settled
 * by a live test rather than by taste.** Option 1 (revert the whole tag list as
 * a diff, so ANY out-of-band add survives) was implemented first and failed the
 * `drift-revert` integ at its final assertion: that fixture injects an
 * `IntegInjected` tag and requires `--revert` to strip it, i.e. "revert removes
 * a console-added tag" is an established contract with a test behind it.
 * Option 1 would redefine revert semantics for a whole property class — which
 * is exactly the design pass the issue said it needed — so the narrow safeguard
 * ships instead, fixing the reported breakage while leaving ordinary tag revert
 * untouched.
 *
 * Scope: TOP-LEVEL tag lists, which is where `buildRevertNewProperties`
 * operates. A tag list nested inside another property (an EC2 launch template's
 * `TagSpecifications`) still reverts wholesale.
 *
 * Order: baseline entries first in baseline order, then the preserved
 * service-managed entries. Providers apply tags as a set and the drift
 * comparator canonicalizes tag-list order on both sides
 * (`drift-normalize.ts`), so the order is for readability / determinism only.
 */
export function mergeTagListForRevert(
  baselineTags: ReadonlyArray<Record<string, unknown>>,
  awsTags: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const baselineKeys = new Set(tagKeys(baselineTags));
  const seen = new Set<string>();
  const preserved = awsTags.filter((t) => {
    const key = t['Key'] as string;
    if (baselineKeys.has(key) || !isServiceManagedTagKey(key) || seen.has(key)) return false;
    // Deduped so the merge and `findRevertPreservedTagKeys` (which reports a
    // SET) cannot disagree when AWS returns the same key twice.
    seen.add(key);
    return true;
  });
  return [...baselineTags, ...preserved];
}

/**
 * The AWS-service-authored tag keys a `--revert` will PRESERVE rather than
 * strip, i.e. those present on the AWS side of a drifted top-level tag list,
 * absent from the revert baseline, and {@link isServiceManagedTagKey} (issue
 * #1501).
 *
 * Reported in the plan so the carve-out of {@link mergeTagListForRevert} is
 * visible BEFORE the confirmation prompt: a user who did want the tag gone
 * learns here that the revert will not do it.
 *
 * @returns dotted `<Key>.<TagKey>` paths, sorted, e.g. `['Tags.AmazonECSManaged']`.
 */
export function findRevertPreservedTagKeys(
  drifts: readonly PropertyDrift[],
  desiredProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>
): string[] {
  const preserved = new Set<string>();
  const driftedTopLevelKeys = new Set<string>();
  for (const d of drifts) {
    const topLevelKey = d.path.split('.', 1)[0];
    if (topLevelKey) driftedTopLevelKeys.add(topLevelKey);
  }

  for (const key of driftedTopLevelKeys) {
    if (!hasOwnKey(desiredProperties, key)) continue;
    if (!isTagListKey(key)) continue;
    const desiredValue = desiredProperties[key];
    const awsValue = ownValue(awsProperties, key);
    const baselineIsTagList =
      isCfnTagList(desiredValue) || (Array.isArray(desiredValue) && desiredValue.length === 0);
    if (!baselineIsTagList || !isCfnTagList(awsValue)) continue;
    const baselineKeys = new Set(tagKeys(desiredValue as Array<Record<string, unknown>>));
    for (const tagKey of tagKeys(awsValue)) {
      if (!baselineKeys.has(tagKey) && isServiceManagedTagKey(tagKey)) {
        preserved.add(`${key}.${tagKey}`);
      }
    }
  }

  return [...preserved].sort();
}

/**
 * The AWS-authored property paths a `--revert` LEAVES UNTOUCHED, for a
 * resource whose state predates observed-capture (issue #1478, semantics
 * settled by issue #1626).
 *
 * The mechanism: `runRevert` picks the revert baseline as
 * `observedProperties ?? properties`. When `observedProperties` is absent, the
 * desired side is the raw TEMPLATE while the previous side is the AWS-CURRENT
 * snapshot — so {@link buildRevertNewProperties}, which overwrites each drifted
 * top-level key with the desired sub-shape wholesale, has no value to carry for
 * any AWS-authored key inside that subtree. For a Glue Iceberg table that
 * reaches `table_type` / `metadata_location`, the same exposure as issue #1461
 * by a different trigger; the general case is ANY resource where AWS writes
 * into a bag the template does not fully declare, on state written before
 * observed-capture.
 *
 * #1478 shipped the **warn and proceed** semantic — the values were still
 * erased, the user was merely told first — while explicitly leaving the door
 * open to "treat 'no observedProperties' as 'previous is unknown' so the merge
 * preserves". Issue #1626 walked through that door for the reasons in
 * {@link mergeUntemplatedValue}: on this baseline cdkd cannot tell an
 * AWS-authored value from an out-of-band change, and resetting on a coin flip
 * is the worse error. So the paths below are now REPORTED AS PRESERVED, and
 * `mergeUntemplatedValue` is what makes that true by merging them into the bag
 * `--revert` actually SENDS — which is the only side a wholesale-replace
 * provider consults. This function is unchanged in what it computes — only in
 * what the caller does about it.
 *
 * Scoped deliberately:
 *
 * - **Only drifted top-level keys.** Non-drifted keys keep their AWS-current
 *   value in `buildRevertNewProperties`, so nothing under them is at stake.
 * - **Only when `observedProperties` is absent.** With it present the desired
 *   side is the deploy-time AWS snapshot, which already carries AWS-authored
 *   fields — removing one there is a legitimate revert of a real console
 *   change, and reporting it would be noise on every run.
 * - **Only keys that vanish.** A key present on both sides with a different
 *   VALUE is the drift the user asked to revert, and it reverts normally.
 *
 * @returns dotted paths, sorted, e.g. `['Parameters.metadata_location']`.
 */
export function findRevertUnbaselinedAwsKeys(
  drifts: readonly PropertyDrift[],
  desiredProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>
): string[] {
  const missing = new Set<string>();
  const driftedTopLevelKeys = new Set<string>();
  for (const d of drifts) {
    const topLevelKey = d.path.split('.', 1)[0];
    if (topLevelKey) driftedTopLevelKeys.add(topLevelKey);
  }

  for (const key of driftedTopLevelKeys) {
    // `buildRevertNewProperties` only overwrites a key the desired side
    // actually OWNS; otherwise the AWS-current value survives untouched.
    if (!hasOwnKey(desiredProperties, key)) continue;
    // A top-level TAG LIST is reverted through `mergeTagListForRevert`, which
    // PRESERVES service-authored entries (issue #1501) — so those are not
    // at stake and must not be reported here, while an ordinary console-added
    // tag still is stripped and still counts.
    collectMissingPaths(
      ownValue(awsProperties, key),
      desiredProperties[key],
      key,
      missing,
      isTagListKey(key) ? isServiceManagedTagKey : undefined
    );
  }

  return [...missing].sort();
}

/**
 * Walk the AWS-side value against the desired-side value, recording every path
 * present on the AWS side and absent on the desired side.
 *
 * Plain objects are descended into. A POSITIONAL array is compared wholesale —
 * the drift comparator itself treats arrays as single values (its paths never
 * carry an index), so an element-wise walk here would report positions the
 * rest of the revert path cannot reason about.
 *
 * A KEYED list is the exception, and it is the shape with the most to drop
 * (issue [#1626](https://github.com/go-to-k/cdkd/issues/1626)). An
 * `[{Key, Value}]` list is semantically a MAP that CFn spells as an array —
 * ELBv2 `LoadBalancerAttributes`, `ListenerAttributes`, `TargetGroupAttributes`
 * and every `Tags` list are this shape — so its entries have stable identities,
 * not positions, and `Key` is exactly what the user would act on. Skipping it
 * left the pass blind precisely where `readCurrentState` returns AWS's FULL
 * attribute set (~20 entries) against a template that declares one or two: the
 * plan warned about nothing while the revert was about to touch eighteen keys.
 *
 * Keyed-list entries are reported in BRACKET form (`LoadBalancerAttributes
 * [deletion_protection.enabled]`) rather than dotted, because attribute keys
 * contain dots themselves and a dotted path would be ambiguous with a nested
 * object.
 *
 * `isPreservedKey` exempts entries the revert does NOT actually drop — the
 * caller passes {@link isServiceManagedTagKey} for a top-level TAG LIST, whose
 * revert goes through {@link mergeTagListForRevert} and keeps `aws:`-prefixed /
 * `AmazonECSManaged` entries (issue #1501). Reporting those would be a warning
 * about a loss that cannot happen.
 */
function collectMissingPaths(
  awsValue: unknown,
  desiredValue: unknown,
  path: string,
  out: Set<string>,
  isPreservedKey?: (key: string) => boolean
): void {
  if (isKeyedList(awsValue)) {
    // An EMPTY desired array is a keyed list carrying no identities, NOT a
    // wholesale replacement — every AWS entry is unbaselined. This arm has to
    // mirror {@link mergeUntemplatedValue}'s `desiredIsEmptyArray` case exactly:
    // without it the merge preserves every entry of a `Tags: []` baseline while
    // this walk reports none, and the plan silently under-claims what survives.
    const desiredIsEmptyArray = Array.isArray(desiredValue) && desiredValue.length === 0;
    if (!isKeyedList(desiredValue) && !desiredIsEmptyArray) {
      // A scalar / object / absent desired side replaces the whole list.
      if (desiredValue === undefined) out.add(path);
      return;
    }
    const desiredKeys = new Set(isKeyedList(desiredValue) ? desiredValue.map((e) => e.Key) : []);
    for (const entry of awsValue) {
      if (desiredKeys.has(entry.Key)) continue;
      if (isPreservedKey?.(entry.Key)) continue;
      out.add(`${path}[${entry.Key}]`);
    }
    return;
  }
  if (!isPlainRecord(awsValue)) return;
  if (!isPlainRecord(desiredValue)) {
    // The desired side is a scalar / array / absent where AWS has an object:
    // the whole AWS subtree goes. Report the containing path rather than
    // enumerating leaves the user cannot act on individually.
    if (desiredValue === undefined) out.add(path);
    return;
  }
  for (const [key, value] of Object.entries(awsValue)) {
    const childPath = `${path}.${key}`;
    // OWN keys (issue #2899's class, PR #3124 review): `in` reads the
    // prototype chain, so an AWS key named `constructor` / `toString` would
    // read as declared by a plain baseline and be walked against a function.
    if (!hasOwnKey(desiredValue, key)) {
      out.add(childPath);
      continue;
    }
    collectMissingPaths(value, desiredValue[key], childPath, out);
  }
}

/**
 * A NON-EMPTY array whose every element is an object carrying a string `Key`.
 *
 * Emptiness is excluded on the AWS side: `[]` carries no identities, so there
 * is nothing to report. It is NOT excluded on the DESIRED side any more
 * (issue #1626) — an empty baseline list means every AWS entry is unbaselined,
 * and since the only caller runs on the template-only baseline where
 * {@link mergeUntemplatedValue} PRESERVES all of them, reporting nothing would
 * leave the plan under-claiming what survives.
 */
function isKeyedList(value: unknown): value is Array<{ Key: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (e) => typeof e === 'object' && e !== null && typeof (e as { Key?: unknown }).Key === 'string'
    )
  );
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `hasPlainPrototype` — the guard {@link isPlainRecord} lacks (it admits
// `Date` / `Map` / `Set` / class instances, whose own enumerable keys are `[]`,
// so a key-walk over one reports "no contradiction" between two values that
// differ; the redaction walk's `deepEqualJsonValue` carries the same guard,
// `secret-redaction.ts`, issue #2869) — is imported from `own-keys.ts`. It is
// NOT imported from `secret-redaction.js`, which several drift suites
// `vi.mock`: a value import from a mocked module reds them with a
// missing-export failure.

/**
 * Merge the AWS-current value with the revert baseline, KEEPING every path the
 * baseline does not declare (issue
 * [#1626](https://github.com/go-to-k/cdkd/issues/1626) items 2 + 3).
 *
 * ## The contract this settles
 *
 * `provider.update(logicalId, physicalId, type, newProperties,
 * previousProperties)` has ONE parameter list and TWO callers:
 *
 * - the deploy engine passes the state-recorded `properties` — the
 *   LAST-DEPLOYED TEMPLATE — so a path present on the previous side and absent
 *   from the desired side means exactly one thing: **the user removed it from
 *   the template**;
 * - `runRevert` passes the FULL `readCurrentState` snapshot, so the same
 *   absence ALSO covers **a path the template never declared at all**.
 *
 * Both provider shapes then destroy that path, by different routes. One that
 * KEY-DIFFS a collection reads the absence as a REMOVAL — ELBv2's
 * `LoadBalancerAttributes`, where `readCurrentState` deliberately emits every
 * attribute AWS reports, puts ~18 untemplated attributes on the removal path
 * against a template declaring one or two. One that REPLACES a bag wholesale
 * (`PutBucketTagging` is documented full-replace; the same holds for every
 * `Put*Configuration`) never consults the previous side at all and simply
 * sends a bag the untemplated path is missing from.
 *
 * That second shape is why the fix lands on the DESIRED side rather than by
 * trimming `previousProperties`: trimming stops the key-diffing removal but
 * leaves the wholesale-replace drop untouched, so half the reported paths
 * would still be erased while the plan claimed otherwise. Merging into the bag
 * cdkd actually SENDS covers both, and is what makes the plan's "left
 * untouched" line true rather than aspirational.
 *
 * ## Scoped to the baseline that cannot tell the two apart
 *
 * Applied ONLY when `observedProperties` is absent — the same gate as
 * {@link findRevertUnbaselinedAwsKeys}'s notice, and for the same reason. With
 * observed-capture present the baseline IS a deploy-time AWS snapshot, so a
 * path AWS reports and the baseline lacks was genuinely added out-of-band and
 * removing it is the revert the user asked for (the `drift-revert` integ
 * fixture requires exactly that for an injected tag). Without it the baseline
 * is the raw TEMPLATE, and "AWS has it, the template does not" is
 * indistinguishable from "AWS authored it" — so the honest answer is to leave
 * it alone. `findRevertUnbaselinedAwsKeys`'s docstring already named this as
 * one of the stricter options #1478 did not foreclose ("treat 'no
 * observedProperties' as 'previous is unknown' so the merge preserves"); this
 * is that option.
 *
 * The structural rules mirror {@link collectMissingPaths} case for case —
 * plain records descend, KEYED `[{Key, Value}]` lists merge by `Key`,
 * positional arrays and scalars are taken from the baseline wholesale — so
 * every path the plan names as preserved IS kept, and a unit test pins that
 * correspondence by diffing the flag-on and flag-off outputs.
 *
 * A service-authored tag is absent from both sides of that comparison and
 * stays consistent: `findRevertUnbaselinedAwsKeys` omits it
 * (`isServiceManagedTagKey`) because the #1501 carve-out already preserves it
 * on the DEFAULT path, so it is not something this flag rescues and reporting
 * it would warn about a loss that cannot happen. The test pins that it
 * survives under BOTH settings.
 *
 * A path the baseline DOES declare always wins, which is what keeps the revert
 * a revert: a drifted value is reset, and one AWS dropped is re-added.
 */
export function mergeUntemplatedValue(awsValue: unknown, desiredValue: unknown): unknown {
  // An EMPTY baseline array is accepted alongside a populated keyed list.
  // `isKeyedList` requires a NON-empty array (an `[]` carries no identities),
  // but a DECLARED-but-empty list — `Tags: []` from a condition-collapsed
  // template — is precisely the shape the #1501 carve-out exists for, and
  // falling through to the wholesale arm would hand AWS `[]` and strip every
  // tag including `AmazonECSManaged`. Under this flag an empty baseline simply
  // contributes no overrides and no re-adds, so every AWS entry is untemplated
  // and every one is preserved — which is what keeps the SUPERSET claim over
  // `mergeTagListForRevert` true for this shape too.
  const desiredIsEmptyArray = Array.isArray(desiredValue) && desiredValue.length === 0;
  if (isKeyedList(awsValue) && (isKeyedList(desiredValue) || desiredIsEmptyArray)) {
    const desiredEntries: ReadonlyArray<{ Key: string }> = isKeyedList(desiredValue)
      ? desiredValue
      : [];
    const desiredByKey = new Map(desiredEntries.map((e) => [e.Key, e]));
    const merged: Array<{ Key: string }> = [];
    // AWS can report the same key twice; `mergeTagListForRevert` dedupes for
    // the same reason. Emitting a duplicate would be REJECTED by
    // `PutBucketTagging` / `ModifyLoadBalancerAttributes`, so first wins.
    const emitted = new Set<string>();
    for (const entry of awsValue) {
      if (emitted.has(entry.Key)) continue;
      emitted.add(entry.Key);
      merged.push(desiredByKey.get(entry.Key) ?? entry);
    }
    // A baseline entry AWS no longer reports is a removal to UNDO, so re-add it.
    for (const entry of desiredEntries) {
      if (emitted.has(entry.Key)) continue;
      emitted.add(entry.Key);
      merged.push(entry);
    }
    return merged;
  }
  if (!isPlainRecord(awsValue) || !isPlainRecord(desiredValue)) {
    // Positional array, scalar, or a shape mismatch: the drift comparator
    // treats these wholesale, so merging would invent a value no other code
    // path can reason about. The baseline wins, exactly as before.
    return desiredValue;
  }
  if (!hasPlainPrototype(awsValue) || !hasPlainPrototype(desiredValue)) {
    // A non-plain object (`Uint8Array`, `Date`, a class instance) cannot be
    // key-merged: `Object.entries` over one fabricates an index map / `{}`
    // into the bag `provider.update` ships — the #2869 class, and strictly
    // worse than the flag-off overlay. Treat it as the shape mismatch it is:
    // the baseline wins, exactly like the arm above. Guarded on BOTH sides
    // deliberately: a non-plain DESIRED side would otherwise fall through to
    // the merge loops, which walk no own keys of it and so return the AWS
    // side wholesale — the OPPOSITE of "the baseline wins".
    return desiredValue;
  }
  // `Object.create(null)`: an own `__proto__` key (a `JSON.parse`d baseline
  // yields one as an OWN key) must stay an own key, not become the prototype —
  // same rule as the preserve walks' rebuild targets below.
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // OWN-key membership, mirroring `collectMissingPaths` (PR #3124 review): an
  // AWS key named `constructor` / `toString` is a legal property name, and
  // `in` on a plain baseline answers `true` for it through the prototype
  // chain — the recursion then merged against `Object`'s function and the
  // member vanished from the payload under `JSON.stringify`.
  for (const [key, value] of Object.entries(awsValue)) {
    merged[key] = hasOwnKey(desiredValue, key)
      ? mergeUntemplatedValue(value, desiredValue[key])
      : value;
  }
  for (const [key, value] of Object.entries(desiredValue)) {
    if (!hasOwnKey(awsValue, key)) merged[key] = value;
  }
  return merged;
}

/**
 * Replace every leaf of a revert payload that still holds a `{{resolve:...}}`
 * token with the value AWS currently has at that position (issue #1914).
 *
 * cdkd downgrades an unresolvable reference from a per-resource failure to a
 * warning, on the premise that `cdkd deploy` resolves through the
 * resolver's same unsupported-service arm — so AWS already holds the literal
 * and replaying it is a no-op. **That premise holds only for records cdkd
 * deployed.** A record adopted by `cdkd import --migrate-from-cloudformation`,
 * or one whose position was edited out of band, holds something ELSE there.
 * `diffAt` skips such a leaf, so it never drifts — but
 * `buildRevertNewProperties` overlays the whole top-level subtree when any
 * SIBLING key drifts, which would push the literal token over that value. That
 * is defect 1 of this issue surviving in a narrower case, on a live AWS write.
 *
 * (When this was written the population was `ssm-secure`, which CloudFormation
 * resolves SERVER-side, so a migrated record held the PLAINTEXT on AWS. Since
 * issue #2482 cdkd resolves that spelling itself and the token never reaches
 * this pass; what survives is a spelling nobody resolves, so the live value
 * here is whatever the user or another tool put at that position.)
 *
 * Deciding by PROVENANCE would need a flag state does not carry. Deciding by
 * what AWS actually holds needs nothing and is exact in both directions: for a
 * cdkd-deployed record AWS holds the token, so copying it back is the same
 * no-op the premise described; for any other record AWS holds a value cdkd
 * cannot compare, which is left untouched.
 *
 * Falls back to KEEPING the token wherever AWS has nothing at that position —
 * that is what `cdkd deploy` sends, so it is the safe residual rather than
 * dropping a property the resource may require. Array descent pairs live
 * elements through {@link pairedLiveItems} — an identity field first, else the
 * array's own literal frame corroborated per LEAF — never by blind index
 * (issue [#2893](https://github.com/go-to-k/cdkd/issues/2893)): until that
 * issue the descent was positional behind a length test, so a readback AWS
 * REORDERED copied element *i*'s live value into element *i*'s token position
 * and `provider.update` shipped a value belonging to a DIFFERENT element. The
 * wildcard handed to the pairing is "whole token OR the redaction mask": a
 * token leaf cannot corroborate an order (its live counterpart is the resolved
 * value, so comparing would refuse every array this pass exists to serve), and
 * a mask leaf belongs to the SIBLING mask walk but must abstain here rather
 * than contradict. Where the pairing refuses, the token is KEPT — the same
 * residual as everywhere else in this pass, and deliberately NOT the mask
 * walk's drop-the-resource refusal: that one would abandon every other drifted
 * property over an alignment this pass never needed, while the kept token is
 * what `cdkd deploy` sends. The trade this accepts: an array whose OTHER
 * leaves genuinely drifted no longer takes a positional copy (the frame cannot
 * corroborate an order it no longer matches), so the token ships there —
 * a no-op for a record cdkd deployed, and for any other record a preserved
 * pre-existing breakage rather than another element's value written live.
 */
export function preserveLiveValuesAtUnresolvedTokens(
  send: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  /**
   * The tokens `resolveStateSecretExpressions` reported as SURVIVING this
   * bag's resolution, and the map it resolved into. Both are REQUIRED: they
   * are what an EMBEDDED token is matched by (issue #2102), and a default
   * would silently turn that arm off.
   */
  unresolvedTokens: ReadonlySet<string>,
  secrets: RecordedSecretValues
): Record<string, unknown> {
  const walk = (value: unknown, live: unknown): unknown => {
    if (typeof value === 'string' && value.includes('{{resolve:')) {
      // A leaf whose WHOLE value is not one token — a token EMBEDDED in a
      // longer string (`"jdbc:...password={{resolve:...}}"`), or a MIXED leaf
      // (`{{notaservice:/host}}:{{secretsmanager:db}}`) that arrives here
      // already PARTIALLY resolved, the secretsmanager half as plaintext — is
      // preserved by SPAN (issue #2102): AWS's value is kept only when it
      // equals this string at every character outside the unresolved tokens'
      // spans, resolved plaintext included. See
      // `liveMatchesUnresolvedTokenFrame` for why that is the disclosure
      // boundary. What it bounds: the bytes the payload GAINS are AWS's own
      // text at a look-alike token's span (ordinary data since issue #2482,
      // which is why nothing is registered for it — see the whole-token arm
      // below), and a resolved half must match byte for byte, so a ROTATED
      // secret AWS still holds beside the token — which no map entry could mask
      // in the #1644 narrowing delta, the retry log or an AWS error text — is
      // never moved in. Anything else (no live string, a literal that differs)
      // keeps the send string: the literal token ships, which is what `cdkd
      // deploy` does, a preserved pre-existing breakage rather than a guess.
      if (!isWholeDynamicReference(value)) {
        return typeof live === 'string' &&
          liveMatchesUnresolvedTokenFrame(value, live, unresolvedTokens, secrets)
          ? live
          : value;
      }
      if (live === undefined) return value;
      // NOTHING IS REGISTERED for the moved value. Until issue #2482 this arm
      // registered `live -> token` into the secrets map when the token was
      // `ssm-secure` — a secret by spelling, whose live value CloudFormation
      // had resolved server-side — so the retry logger, the AWS-error report
      // and the #1644 narrowing delta could mask a plaintext this pass had
      // just moved into the payload. That spelling now resolves before it can
      // reach here, and no other survivor is a secret by definition: it is
      // text that merely looks like a reference, so the live value at its
      // position is ordinary data. Registering ordinary data would make a
      // redaction NEEDLE out of it — every unrelated delta leaf equal to it
      // rewritten into this token, after which the next deploy ships the token
      // to AWS (the #1904 wrong-reference corruption, one spelling over).
      //
      // ONLY A STRING is copied (issue
      // [#2920](https://github.com/go-to-k/cdkd/issues/2920)). The baseline
      // types this position as a string — the token IS one — so a live
      // OBJECT / ARRAY / number / `null` here is a container or scalar of
      // another type at a string-typed property, and copying it ships a
      // wrong-shape value to the wire (the #2855 class, arriving through the
      // preservation arm instead of the baseline). Every route reaches this
      // line — a keyed pairing, a corroborated frame, and the forced 1-vs-1
      // singleton `acceptForcedSingleton` admits uncorroborated. The residual
      // is this pass's own: the token is KEPT, what `cdkd deploy` sends. The
      // sibling mask walk documents the OPPOSITE choice for its non-string
      // live values (it still copies, because ITS refusal drops the whole
      // resource); that trade does not carry here, where refusing costs a
      // kept token rather than a dropped revert.
      return typeof live === 'string' ? live : value;
    }
    if (Array.isArray(value)) {
      // Pair live elements the way the sibling mask walk does — identity
      // field first, else the array's own literal frame corroborated per
      // leaf — with the wildcard tuned to THIS pass's markers, and the
      // forced-singleton acceptance its refusal cost demands (issue #2893 +
      // PR #2912 blocker 1; see the pairing's doc for both derivations).
      //
      // Self-corroboration needs a bound and "it runs FIRST" is not it (PR
      // #2912 review, both rounds): `buildRevertNewProperties` DOES copy
      // live values into this bag — `{...awsProperties}` for every
      // non-drifted key, and `mergeUntemplatedValue`'s untemplated paths
      // under `preserveUntemplated` — and MIXED-provenance lists exist too:
      // `mergeUntemplatedValue`'s keyed arm and `mergeTagListForRevert`
      // both emit lists whose members come from both sides. The actual
      // bound is IDENTITY, not single-sourcing and not position: `Key` /
      // `Name` are `ARRAY_IDENTITY_KEYS`, so a merged list normally takes
      // the identity arm, which reads no order evidence at all. That is
      // what carries it, because the two merges do NOT agree on ordering:
      // `mergeUntemplatedValue`'s keyed arm iterates the AWS list and
      // substitutes by `Key` (AWS positions), while `mergeTagListForRevert`
      // returns `[...baselineTags, ...preserved]` — BASELINE order with
      // AWS-only extras appended, so its output is not at AWS's positions
      // at all. Identity pairing needs UNIQUENESS on BOTH sides
      // (`isUniquelyKeyedBy` — AWS can report the same key twice, as
      // `mergeUntemplatedValue`'s own dedupe records), and the fallback is
      // still sound WITHOUT any positional premise: a merged list falling
      // to the frame arm (a duplicated or empty `Key`) corroborates
      // leaf-by-leaf, so an alignment that is shifted — however it got
      // that way — CONTRADICTS and refuses rather than donating. Unkeyed arrays never
      // mix at all: the merge's fall-through takes them from the baseline
      // wholesale, and a non-drifted key's array is AWS wholesale, where
      // every copy is send ≡ live.
      const liveItems = pairedLiveItems(value, live, isTokenOrMaskLeaf, carriesTokenOrMask, true);
      return value.map((item, i) => walk(item, liveItems?.[i]));
    }
    if (value !== null && typeof value === 'object') {
      // A non-plain object (`Date`, `Uint8Array`, a class instance) is a LEAF
      // returned BY IDENTITY, never rebuilt: `Object.entries` over one yields
      // `[]` or index keys, so the rebuild below would FABRICATE `{}` (or a
      // plain index map) and `provider.update` would ship it — the #1498 /
      // #1501 corruption class on the WRITE path, the #2869 flattening's twin.
      // Reachable: `awsProperties` is `readCurrentState`'s RAW SDK return with
      // no JSON round-trip, and `buildRevertNewProperties` copies its
      // non-drifted subtrees into the send bag. Such a value cannot carry a
      // nested `{{resolve:...}}` token anyway.
      if (!hasPlainPrototype(value)) return value;
      const liveObject = isPlainRecord(live) ? live : undefined;
      // `Object.create(null)`: see the mask walk's twin comment — an own
      // `__proto__` key must stay an own key, not become the prototype.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, liveObject === undefined ? undefined : ownValue(liveObject, k));
      }
      return out;
    }
    return value;
  };
  return walk(send, awsProperties) as Record<string, unknown>;
}

/**
 * Paths in the bag `--revert` is about to send whose value is an unresolved
 * CloudFormation intrinsic OBJECT — `{ Ref: ... }` or a single-key
 * `{ 'Fn::*': ... }` (issue
 * [#2855](https://github.com/go-to-k/cdkd/issues/2855)).
 *
 * WHY THE SHAPE IS REACHABLE. `cdkd import`'s warn path persists raw intrinsic
 * objects into a record's `properties`, and issue #2842's baseline refusal is
 * what routes such a record here: it leaves `observedProperties` undefined, so
 * `runRevert`'s `revertBaseline` falls back to the raw bag.
 * `resolveStateSecretExpressions` re-resolves only `{{resolve:...}}` STRINGS,
 * so the OBJECT walks through it untouched, and the drift comparator's
 * `{{resolve:` skip is a string test too — the object simply differs from the
 * readback, drifts, and `buildRevertNewProperties` overlays it into the send
 * bag.
 *
 * WHY IT MUST BE REFUSED rather than shipped or live-preserved. Measured
 * (issue #2855's open question) with mocked SDK clients on both routes: NO
 * route fails loudly on cdkd's side. `SSMParameterProvider.update` puts the
 * raw object straight into `PutParameterCommand.input.Value`;
 * `CloudControlProvider.update` emits it verbatim as a JSON-patch value, and
 * for a `JSON_STRING_PROPERTIES` type (`AWS::Events::Rule.EventPattern`) it is
 * `JSON.stringify`ed into a schema-VALID string — a payload AWS cannot even
 * reject on type, i.e. guaranteed silent corruption. Live-preserving (the
 * token pass's answer) is no better: the intrinsic's real value depends on
 * template context a synth-free command does not have, and copying whatever
 * AWS holds would silently bless an out-of-band edit as the baseline.
 *
 * The predicate mirrors the resolver's own rule (a CloudFormation intrinsic is
 * ALWAYS a single-key object; `detectUnknownIntrinsicKey` in
 * `intrinsic-resolver/ref-values.ts` states why single-key is what keeps a real
 * property literally named `Ref` from false-positiving). A non-plain object
 * (`Date`, `Uint8Array`) cannot be an intrinsic and is not descended. The scan
 * is scoped to `topLevelKeys` — the DRIFTED keys, the only ones
 * `buildRevertNewProperties` sources from the baseline — so a value that
 * merely looks intrinsic under a non-drifted key cannot refuse a revert it
 * never participates in. The caller hands it the BASELINE
 * (`desiredProperties`), never the post-overlay send bag: on the very
 * population this refusal exists for, `mergeUntemplatedValue`'s key-merge can
 * FUSE a single-key intrinsic with a plain-record live value into a multi-key
 * object the predicate no longer matches, while every overlay arm re-emits
 * every baseline path into the send bag in some shape — so the baseline scan
 * is complete where the merged-bag scan was dilutable, and an AWS-echoed
 * lookalike (which lives only in the overlay) stays exempt by construction.
 * The caller additionally gates the whole scan on
 * `observedProperties === undefined` — intrinsic objects reach a revert
 * baseline only through the raw-`properties` fallback, while an
 * `observedProperties` baseline is READBACK-derived, where a single-key map
 * named like an intrinsic is a real AWS value and a refusal would be
 * permanent (the call site's comment carries the full derivation).
 *
 * The whole flagged leaf is reported once; nothing beneath it is separately
 * scanned, since the caller refuses the resource on the first path anyway.
 */
export function collectUnresolvedIntrinsicObjectPaths(
  bag: Record<string, unknown>,
  topLevelKeys: ReadonlySet<string>
): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (!hasPlainPrototype(value)) return;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      const key = keys[0];
      if (keys.length === 1 && key !== undefined && (key === 'Ref' || key.startsWith('Fn::'))) {
        found.push(path);
        return;
      }
      for (const [k, v] of Object.entries(record)) {
        // `path` is never '' here: the scan loop below seeds every visit
        // with the top-level key itself.
        visit(v, `${path}.${k}`);
      }
    }
  };
  for (const key of topLevelKeys) {
    // `Object.hasOwn`, not `in`: the bag is a caller-built record and an
    // inherited name (`constructor`, `toString`) is not a baseline property.
    if (Object.hasOwn(bag, key)) visit(bag[key], key);
  }
  return found.sort();
}
