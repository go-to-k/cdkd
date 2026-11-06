/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  TRANSITION_ALIASES,
  TRANSITION_DATE_KEY,
  foldToleratedAliases,
} from './effective-items.js';
import {
  coerceCfnBoolean,
  configStringRefusal,
  requireConfigArray,
  requireConfigObject,
} from '../../config-shape.js';
import { coerceCfnNumber, isPlainObject, mergeLegacySingular } from './shared.js';
import { parseCfnTimestamp } from '../../../utils/cfn-timestamp.js';

/** The refusal paths the lifecycle applier and its fold SHARE (issue #1755). */
export const LIFECYCLE_RULE_PATH = 'AWS::S3::Bucket LifecycleConfiguration.Rules[]';
export const LIFECYCLE_FILTER_PATH = `${LIFECYCLE_RULE_PATH}.Filter`;
export const LIFECYCLE_TAG_FILTERS_PATH = `${LIFECYCLE_RULE_PATH}.TagFilters`;
/** What `readConfigString(rule, 'Status', ...)` substitutes for an ABSENT key. */
export const LIFECYCLE_DEFAULT_STATUS = 'Enabled';
/** The rule's status member, held in a CONST so the fold writes it COMPUTED. */
export const LIFECYCLE_STATUS_KEY = 'Status';

/** A lifecycle rule's location scope, gathered from EVERY source CFn expresses it in. */
export interface LifecycleScope {
  prefix: string | undefined;
  tagFilters: Array<{ Key: string; Value: string }> | undefined;
  sizeGt: number | undefined;
  sizeLt: number | undefined;
}

/**
 * Gather a rule's full location scope — module-level so the applier and the
 * fold run the SAME function rather than two copies that can disagree about
 * which key wins (`.claude/rules/providers.md`: share ONE helper with the
 * provisioning path, or state and template end up narrowed to different keys
 * and the fix becomes the bug).
 *
 * `TagFilters` lives at the RULE level in the CFn schema and CDK synthesizes it
 * there; the `Filter`-side reads are cdkd's accommodation for SDK-shaped /
 * imported input.
 */
export function lifecycleRuleScope(rule: Record<string, unknown>): LifecycleScope {
  const filter = rule['Filter'] as Record<string, unknown> | undefined;
  return {
    prefix: (filter?.['Prefix'] ?? rule['Prefix']) as string | undefined,
    tagFilters: (filter?.['TagFilters'] ?? rule['TagFilters']) as
      | Array<{ Key: string; Value: string }>
      | undefined,
    sizeGt: (filter?.['ObjectSizeGreaterThan'] ?? rule['ObjectSizeGreaterThan']) as
      | number
      | undefined,
    sizeLt: (filter?.['ObjectSizeLessThan'] ?? rule['ObjectSizeLessThan']) as number | undefined,
  };
}

/**
 * Can this rule stay in the deprecated V1 (top-level `Prefix`) form? See
 * {@link lifecycleUsesFilterForm} — S3 forbids MIXING the two forms in one
 * configuration, so the answer is decided across the whole rule list.
 */
export function lifecycleRuleIsPlainPrefixOnly(rule: Record<string, unknown>): boolean {
  // `!= null`, not `!== undefined`: the container guard treats an explicit
  // `Filter: null` as ABSENT, so a strict compare would read the same value as
  // PRESENT here and force every rule into V2 Filter form.
  if (rule['Filter'] != null) return false;
  const s = lifecycleRuleScope(rule);
  return (
    s.prefix !== undefined &&
    // `== null`: an explicit `TagFilters: null` is "no entries" per the
    // list-block contract, and the strict compare sent `null` into `.length`.
    (s.tagFilters == null || s.tagFilters.length === 0) &&
    s.sizeGt === undefined &&
    s.sizeLt === undefined
  );
}

/** V1 vs V2 is decided ONCE for the whole configuration — see the applier's note. */
export function lifecycleUsesFilterForm(rules: Array<Record<string, unknown>>): boolean {
  return !rules.every(lifecycleRuleIsPlainPrefixOnly);
}

/** Discards the message; the fold only needs the PREDICATE's answer. */
export const IGNORE_REFUSAL_MESSAGE = (): void => {};

/**
 * Would `applyLifecycleConfiguration` REFUSE this rule, and therefore skip the
 * whole Put? (issue #1755)
 *
 * Runs the applier's own three guards rather than restating them — the
 * "do not HAND-ROLL the mirror, run the wire's own predicate" rule, whose
 * cautionary tale is the S3 schedule fold, where an approximation disagreed
 * with the wire on three of nine container shapes.
 */
export function lifecycleRuleRefused(rule: Record<string, unknown>): boolean {
  const rawFilter = rule['Filter'];
  if (
    rawFilter != null &&
    requireConfigObject(rawFilter, LIFECYCLE_FILTER_PATH, {
      onUnusable: IGNORE_REFUSAL_MESSAGE,
    }) === undefined
  ) {
    return true;
  }
  const filter = rawFilter as Record<string, unknown> | undefined;
  const rawTagFilters = filter?.['TagFilters'] ?? rule['TagFilters'];
  if (
    rawTagFilters != null &&
    requireConfigArray(rawTagFilters, LIFECYCLE_TAG_FILTERS_PATH, {
      onUnusable: IGNORE_REFUSAL_MESSAGE,
    }) === undefined
  ) {
    return true;
  }
  return (
    configStringRefusal(rule, 'Status', LIFECYCLE_DEFAULT_STATUS, LIFECYCLE_RULE_PATH) !== undefined
  );
}

/**
 * Deep, key-ORDER-insensitive equality — the identity test for a fold that
 * rebuilds nested objects (`Filter`) even when nothing about them changed.
 *
 * `Object.is` alone would report every folded rule as changed and rewrite the
 * state record of every lifecycle-configured bucket; `JSON.stringify` would
 * report a pure reordering as a change, which is not one worth recording.
 */
export function deepSameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((element, index) => deepSameValue(element, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepSameValue(a[key], b[key]));
  }
  return false;
}

/**
 * The ISO string `readLifecycle` emits for a date the applier sends as
 * `parseCfnTimestamp(value)` (a string) or `new Date(value)` (a number).
 *
 * DETERMINISM IS A PRECONDITION, not a nicety (PR review). `new Date(str)`
 * resolves some strings in the HOST's local zone — `new Date('0')` is
 * `1999-12-31T15:00:00Z` under JST and `2000-01-01T00:00:00Z` under UTC. This
 * feeds `canonicalizeDesiredProperties`, a DIFF-side pure function that runs
 * wherever the CLI runs: a CI runner in UTC and a laptop in JST would
 * canonicalize the SAME template to different ISO strings and manufacture a diff
 * neither machine can clear, which is strictly worse than the phantom drift the
 * fold exists to remove. So only the forms with ONE meaning on every host are
 * folded: a bare `YYYY-MM-DD` (spec-UTC), a date-time carrying `Z` or a
 * `±HH:MM` offset, an offset-less `YYYY-MM-DDTHH:mm[:ss[.sss]]` (which
 * `parseCfnTimestamp` reads as UTC, as CFn does — issue #5311; the `t` / space
 * separators it also takes are folded alike), and an epoch
 * NUMBER. Everything else — `'Jan 1 2030'`, `'0'` — is left ALONE, which keeps
 * the record machine-independent at the cost of not normalizing a shape almost
 * no template uses.
 *
 * @returns `undefined` for a value that cannot become a valid `Date`, or whose
 *   `Date` would depend on the host timezone — in both cases there is no
 *   effective value this can claim AWS will report, so the fold leaves the rule
 *   alone.
 */
export const TIMEZONE_INDEPENDENT_DATE =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function cfnDateToIso(value: unknown): string | undefined {
  let parsed: Date;
  if (typeof value === 'string') {
    if (!TIMEZONE_INDEPENDENT_DATE.test(value)) return undefined;
    parsed = parseCfnTimestamp(value);
  } else if (typeof value === 'number') {
    parsed = new Date(value);
  } else {
    return undefined;
  }
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** The legacy SINGULAR action objects the CFn schema still declares (issue #1754). */
export const LEGACY_SINGULAR_TRANSITIONS = [
  ['Transitions', 'Transition'],
  ['NoncurrentVersionTransitions', 'NoncurrentVersionTransition'],
] as const;

/**
 * Merge the legacy singular `Transition` / `NoncurrentVersionTransition` into
 * the plural array, exactly as the wire does (issue #1754).
 *
 * The CFn `Rule` definition still declares BOTH spellings and
 * `applyLifecycleConfiguration` folds the singular into the plural array via
 * {@link mergeLegacySingular}, so `readLifecycle` can only ever emit the plural.
 * A rule declaring the singular therefore recorded a key AWS can never
 * report — the #1686 never-emitted-KEY class through the SHAPE — with no
 * warning anywhere, because nothing is malformed and nothing is substituted.
 *
 * It shares `mergeLegacySingular` itself rather than re-deriving the collision
 * rule, per the share-ONE-helper rule. What it does NOT do is pass a no-op
 * callback and fold regardless: on a `StorageClass` COLLISION the wire DROPS the
 * singular and WARNS, so a colliding rule is left COMPLETELY alone (both keys
 * kept). The NON-colliding case, which is the population this exists for, has
 * no fault to report and folds.
 *
 * Be precise about WHICH signal that preserves, because the obvious answer is
 * wrong (PR review). It is NOT the deploy-time warning: the record and the
 * canonicalized template are folded by the same function either way, so they
 * compare equal after the first deploy and the Put stops re-firing whichever
 * choice is made. What leaving it alone preserves is the `cdkd drift` report —
 * state keeps a `Transition` key `readLifecycle` can never emit, so drift
 * re-reports the rule until the template drops one of the two declarations.
 * Folding it would make state match the readback exactly and render a
 * template fault S3 itself rejects completely invisible.
 *
 * @returns `rule` BY IDENTITY when no legacy singular is declared.
 */
export function foldLegacySingularTransitions(
  rule: Record<string, unknown>
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [pluralKey, singularKey] of LEGACY_SINGULAR_TRANSITIONS) {
    const singular = rule[singularKey];
    // `isPlainObject`, the same screen `mergeLegacySingular` applies: anything
    // else is ignored by the wire AND left visible here.
    const hasSingular = isPlainObject(singular);
    const plural = rule[pluralKey];
    // `mergeLegacySingular` also `.filter(isPlainObject)`s the PLURAL array, and
    // it does that whether or not a legacy singular is declared — so a junk
    // element is dropped from the wire either way, and the fold has to drop it
    // too or the record carries an entry AWS was never sent. Keying the whole
    // step on the singular's presence made that filtering depend on an unrelated
    // key (PR review).
    const needsFilter = Array.isArray(plural) && plural.some((element) => !isPlainObject(element));
    if (!hasSingular && !needsFilter) continue;
    let collided = false;
    const merged = mergeLegacySingular(plural, hasSingular ? singular : undefined, () => {
      collided = true;
    });
    out ??= { ...rule };
    if (collided) {
      // The singular stays visible (see above), but the plural's junk elements
      // still went nowhere. `merged` IS that filtered array — `mergeLegacySingular`
      // returns the screened plural on a collision — so this reuses the helper's
      // answer instead of re-deriving its `.filter(isPlainObject)` rule.
      if (needsFilter) out[pluralKey] = merged;
      continue;
    }
    out[pluralKey] = merged;
    if (hasSingular) delete out[singularKey];
  }
  return out ?? rule;
}

/**
 * Emit a transition's `TransitionDate` as the ISO string the readback emits
 * (PR review of issues #1754 / #1755).
 *
 * The alias fold above only RENAMES `Date` -> `TransitionDate`, but the applier
 * sends `parseCfnTimestamp(t['TransitionDate'] ?? t['Date'])` and `readLifecycle` emits
 * `t.Date.toISOString()` — so a hand-written / imported `TransitionDate:
 * '2030-01-01'` recorded a value the readback can never match, with no warning
 * and nothing malformed. Exactly the class {@link foldLifecycleExpiration}
 * closes for the RULE-level `ExpirationDate` one member over; found by review
 * because the fold and the readback were compared per member rather than
 * per item.
 *
 * `NoncurrentVersionTransitions` needs no twin of this: `toSdkNvt` has no date
 * member at all.
 *
 * @returns the item BY IDENTITY when no date is declared, or when it is one the
 *   applier would put on the wire as an Invalid Date (nothing to record).
 */
export function foldTransitionDate(item: Record<string, unknown>): Record<string, unknown> {
  const declared = item[TRANSITION_DATE_KEY];
  // TRUTHINESS, not presence — the same defect this fold's own commit fixed one
  // member over for the nested `Expiration.Date`, and missed on the member it
  // was adding. The applier reads `(t['TransitionDate'] ?? t['Date']) ?
  // parseCfnTimestamp(...) : undefined`, so a declared `0` sends NO date at all while
  // `cfnDateToIso(0)` happily answers `1970-01-01T00:00:00.000Z` — recording it
  // would MANUFACTURE the permanent phantom drift this fold exists to remove.
  if (!declared) return item;
  const iso = cfnDateToIso(declared);
  if (iso === undefined || iso === declared) return item;
  // COMPUTED key, for the same #1475 reason {@link EVENTBRIDGE_CONFIG_KEY}
  // records: a DIFF-side literal naming the member reads as a whole-blob
  // hand-off to `gen-nested-key-coverage`'s write-side walk, AND it
  // withdraws the name from the reverse-map exclusion that keeps `readLifecycle`
  // from vouching for the forward mapper.
  const out = { ...item };
  out[TRANSITION_DATE_KEY] = iso;
  return out;
}

/**
 * Drop a declared-but-EMPTY transition list (issue #1755).
 *
 * The applier sets `sdkRule.Transitions` / `.NoncurrentVersionTransitions` only
 * when the merged array is non-empty, and `readLifecycle` emits each only under
 * `r.<List> && r.<List>.length > 0` — so an empty declaration is one key the
 * readback can never carry. Measured on the reverse-mapper, not assumed: the
 * lifecycle block's OWN empty-collection placeholder answers the opposite way
 * (issue #1718) because `readLifecycle` DOES emit `{Rules: []}`.
 */
export function dropEmptyTransitionLists(rule: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [pluralKey] of LEGACY_SINGULAR_TRANSITIONS) {
    const list = rule[pluralKey];
    if (!Array.isArray(list) || list.length > 0) continue;
    out ??= { ...rule };
    delete out[pluralKey];
  }
  return out ?? rule;
}

/**
 * Reshape the rule's expiration onto the CFn spellings `readLifecycle` emits
 * (issue #1755 item 1).
 *
 * The CFn `Rule` definition declares `ExpirationDate` / `ExpirationInDays` and
 * the RULE-level `ExpiredObjectDeleteMarker`, and has NO `Expiration` member;
 * the applier additionally accepts a cdkd-only `Expiration` OBJECT as a third
 * source. The readback used to emit only the SDK-shaped `Expiration` object, so
 * state and the readback carried different key sets for essentially every
 * lifecycle-configured bucket CDK creates. The fix is split, per the issue: the
 * READBACK now emits the CFn scalars (recording the SDK shape instead would put
 * a spelling in state that no CFn template can declare), and this is the desired
 * side folding onto the same choice.
 *
 * The rule is left COMPLETELY alone in three cases, each because the wire does
 * something this fold must not conceal:
 *
 * - a rule-level `ExpiredObjectDeleteMarker` the wire cannot read
 *   (`coerceCfnBoolean` answers `undefined`): the wire silently ignores it, and
 *   nothing warns, so the difference is the user's only signal;
 * - a date the wire would send as an Invalid Date, or one whose `Date` depends
 *   on the host timezone (see {@link cfnDateToIso});
 * - a rule-level `ExpiredObjectDeleteMarker: true` ALONGSIDE a `Days` / `Date`:
 *   S3 forbids the combination, so the applier sends the `Days` / `Date` and
 *   WARNS that the marker was not applied. Folding the marker away on both sides
 *   would stop that difference being reported, so `cdkd drift` re-reporting it
 *   until the template drops one of the two is the correct standing signal.
 *
 * @returns `rule` BY IDENTITY when nothing expiration-shaped is declared.
 */
export function foldLifecycleExpiration(rule: Record<string, unknown>): Record<string, unknown> {
  const declaredMarker = rule['ExpiredObjectDeleteMarker'];
  const ruleLevelMarker = coerceCfnBoolean(declaredMarker);
  if (declaredMarker !== undefined && ruleLevelMarker === undefined) return rule;
  if (
    rule['ExpirationInDays'] === undefined &&
    rule['ExpirationDate'] === undefined &&
    rule['Expiration'] === undefined &&
    declaredMarker === undefined
  ) {
    return rule;
  }

  // `||`, not `??`: this MIRRORS the applier's own precedence read verbatim.
  const expiration = rule['ExpirationInDays'] || rule['ExpirationDate'] || rule['Expiration'];
  let days: unknown;
  let date: string | undefined;
  let marker: boolean | undefined;
  if (typeof expiration === 'number') {
    days = expiration;
  } else if (typeof expiration === 'string') {
    const iso = cfnDateToIso(expiration);
    if (iso === undefined) return rule;
    date = iso;
  } else if (isPlainObject(expiration)) {
    if (expiration['Days'] !== undefined) days = expiration['Days'];
    // TRUTHINESS, not presence: the applier reads `exp['Date'] ? parseCfnTimestamp(...) :
    // undefined`, so a falsy `Date` (`0`, `false`, `''`) sends NO date at all
    // and recording one would describe a value AWS does not hold (PR review).
    if (expiration['Date']) {
      const iso = cfnDateToIso(expiration['Date']);
      if (iso === undefined) return rule;
      date = iso;
    }
    const nested = expiration['ExpiredObjectDeleteMarker'];
    if (nested !== undefined) {
      // Forwarded verbatim by the applier (`as boolean | undefined`), so only a
      // real boolean is something this can claim AWS will report back.
      if (typeof nested !== 'boolean') return rule;
      marker = nested;
    }
  } else if (expiration) {
    // Truthy but not a shape this can describe. An ARRAY does reach the
    // applier's `typeof === 'object'` branch, but every member probe indexes to
    // `undefined`, so what goes on the wire is an EMPTY `Expiration` that leaves
    // the rule action-less and S3 rejects — there is no effective value to
    // record. A boolean / unresolved intrinsic sends nothing at all. Left
    // visible either way.
    return rule;
  }

  if (ruleLevelMarker === true) {
    if (days !== undefined || date !== undefined) return rule;
    days = undefined;
    date = undefined;
    marker = true;
  }

  const out = { ...rule };
  delete out['ExpirationInDays'];
  delete out['ExpirationDate'];
  delete out['Expiration'];
  delete out['ExpiredObjectDeleteMarker'];
  if (days !== undefined) out['ExpirationInDays'] = days;
  if (date !== undefined) out['ExpirationDate'] = date;
  if (marker !== undefined) out['ExpiredObjectDeleteMarker'] = marker;
  return out;
}

/**
 * Fold the legacy scalar `NoncurrentVersionExpirationInDays` onto the OBJECT
 * form `readLifecycle` emits (issue #1755 item 2).
 *
 * CFn declares BOTH spellings here — unlike the expiration sibling above — so
 * the readback has to pick one and the desired side has to fold to the same
 * choice. The OBJECT wins because it is the only one that can express
 * `NewerNoncurrentVersions`, so folding towards it is lossless in both
 * directions; and it is also what the wire already prefers when both are
 * declared, which is why a rule carrying both simply DROPS the scalar here.
 *
 * `coerceCfnNumber`, not `typeof === 'number'`: it is the predicate the wire
 * runs, and the wire sends the COERCED number, so a hand-written `"365"` is
 * recorded as `365` — exactly what AWS reports back.
 */
export function foldNoncurrentVersionExpiration(
  rule: Record<string, unknown>
): Record<string, unknown> {
  const legacy = rule['NoncurrentVersionExpirationInDays'];
  if (legacy === undefined) return rule;
  const declaredObject = rule['NoncurrentVersionExpiration'];
  // A present-but-non-object modern form is malformed: the wire's
  // `isPlainObject` test rejects it and falls through to the scalar, so folding
  // would REPLACE the malformed value with a well-formed one and hide it.
  if (declaredObject !== undefined && !isPlainObject(declaredObject)) return rule;
  const out = { ...rule };
  delete out['NoncurrentVersionExpirationInDays'];
  if (isPlainObject(declaredObject)) return out;
  const days = coerceCfnNumber(legacy);
  // Unreadable scalar: the wire sends NO NoncurrentVersionExpiration at all and
  // nothing warns, so the difference is the user's only signal.
  if (days === undefined) return rule;
  out['NoncurrentVersionExpiration'] = { NoncurrentDays: days };
  return out;
}

/**
 * Rebuild the rule's location scope in the shape `readLifecycle` emits for the
 * `Filter` the applier actually sends (issue #1755 item 3).
 *
 * This is not a spelling at all but a defaulted-but-SENT member (#1718's
 * class): a rule with no declared scope is SENT `Filter: {Prefix: ''}` in a V2
 * configuration, AWS holds it, the readback reports it, and the record was one
 * key short. The fold is wider than the issue's headline because the same round
 * trip moves three more shapes — a bare top-level `Prefix` becomes
 * `Filter: {Prefix}`, rule-level `TagFilters` become `Filter: {TagFilters}`, and
 * rule-level `ObjectSize*` move under `Filter` — all of which the readback emits
 * only under `Filter`.
 *
 * `useFilterForm` is decided ACROSS ALL RULES, which is why this takes it as a
 * parameter instead of being a pure per-rule function: in a V1 configuration
 * (every rule scoped by exactly one top-level `Prefix`) nothing moves at all.
 *
 * WHY THIS RECORDS `Filter` WHEN THE EXPIRATION SIBLING REFUSED THE SDK SHAPE,
 * since the two answer the same objection opposite ways one member apart (PR
 * review — without this, the next author "fixes" one to match the other). The
 * CFn `Rule` definition declares no `Filter` member either, so by the
 * `Expiration` argument this too should have been fixed on the READBACK side.
 * It is not, for a reason that does not apply there: the rule-level CFn scalars
 * can express every `Expiration` the SDK returns, and so the reverse map is
 * LOSSLESS — whereas the V2 `Filter` carries a distinction with no rule-level
 * spelling at all. A scope-less rule is SENT `Filter: {Prefix: ''}`, and the
 * only rule-level rendering of that is a top-level `Prefix: ''`, which is the V1
 * form — a different configuration that S3 forbids mixing with V2. Reverse-
 * mapping would therefore destroy the V1/V2 distinction state needs to
 * reproduce the call. `readLifecycle` has emitted `Filter` since issue #1388, so
 * both sides already meet there; this fold makes the desired side agree rather
 * than moving the meeting point.
 */
export function foldLifecycleScope(
  rule: Record<string, unknown>,
  useFilterForm: boolean
): Record<string, unknown> {
  const { prefix, tagFilters, sizeGt, sizeLt } = lifecycleRuleScope(rule);
  const hasTags = tagFilters != null && tagFilters.length > 0;
  const componentCount =
    (hasTags ? 1 : 0) +
    (prefix !== undefined ? 1 : 0) +
    (sizeGt !== undefined ? 1 : 0) +
    (sizeLt !== undefined ? 1 : 0);

  let filter: Record<string, unknown> | undefined;
  if (componentCount > 1) {
    // The `And` form, whose reverse map flattens every member back to the rule's
    // own `Filter`. Built in the readback's own key order.
    filter = {};
    if (prefix !== undefined) filter['Prefix'] = prefix;
    if (hasTags) filter['TagFilters'] = tagFilters;
    if (sizeGt !== undefined) filter['ObjectSizeGreaterThan'] = sizeGt;
    if (sizeLt !== undefined) filter['ObjectSizeLessThan'] = sizeLt;
  } else if (hasTags) {
    // Both the multi-tag `And: {Tags}` form and the single `Tag` form reverse-map
    // to the same `TagFilters` array.
    filter = { TagFilters: tagFilters };
  } else if (sizeGt !== undefined) {
    filter = { ObjectSizeGreaterThan: sizeGt };
  } else if (sizeLt !== undefined) {
    filter = { ObjectSizeLessThan: sizeLt };
  } else if (useFilterForm) {
    filter = { Prefix: prefix ?? '' };
  }

  const out = { ...rule };
  delete out['Filter'];
  delete out['Prefix'];
  delete out['TagFilters'];
  delete out['ObjectSizeGreaterThan'];
  delete out['ObjectSizeLessThan'];
  if (filter !== undefined) out['Filter'] = filter;
  // V1: the single top-level `Prefix` stays where it is, which is where the
  // readback emits it from.
  else if (prefix !== undefined) out['Prefix'] = prefix;
  return out;
}

/**
 * The `LifecycleConfiguration` cdkd ACTUALLY SENDS, in the spelling
 * `readLifecycle` emits (issue #1748) — the lifecycle half of the same class.
 *
 * `applyLifecycleConfiguration` accepts the SDK day/date spellings alongside the
 * CFn ones on `Transitions` (`t['TransitionInDays'] ?? t['Days']`,
 * `t['TransitionDate'] ?? t['Date']`) while `readLifecycle` emits only
 * `TransitionInDays` / `TransitionDate` — again the only spellings the registry
 * schema declares (`Transition` is `{StorageClass, TransitionDate,
 * TransitionInDays}`). `NoncurrentVersionTransitions` has no alias to fold: its
 * `TransitionInDays` is schema-required, so the `NoncurrentDays` spelling is
 * refused pre-flight and the applier no longer reads it (issue #3585).
 *
 * Issues #1754 / #1755 finished the block, so the "still differs on those keys"
 * caveat this doc carried is gone: the legacy SINGULAR `Transition` /
 * `NoncurrentVersionTransition` objects are MERGED here exactly as the wire
 * merges them ({@link foldLegacySingularTransitions}), the rule-level
 * `Expiration` / `NoncurrentVersionExpiration` reshapes are folded onto the
 * spellings the readback emits ({@link foldLifecycleExpiration} /
 * {@link foldNoncurrentVersionExpiration}), and the sent-but-unrecorded
 * `Filter` is supplied from the rule's full gathered SCOPE
 * ({@link foldLifecycleScope}).
 *
 * @returns `config` BY IDENTITY when the declared bag IS what goes on the wire.
 */
export function effectiveLifecycleConfiguration(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  const rules = config['Rules'];
  if (!Array.isArray(rules)) return config;
  const objectRules = rules.filter(isPlainObject);
  // Leave the WHOLE configuration alone whenever the wire would not send it as
  // declared, per the "mirror what the wire does" rule:
  //
  // - a non-object rule ELEMENT — the applier's `.map` would build a rule from
  //   nothing and S3 answers `MalformedXML`;
  // - an EMPTY rules array — the Put is SKIPPED (issues #1671 / #1718) and
  //   `readLifecycle` answers `{Rules: []}` for an unconfigured bucket, so the
  //   declared placeholder ALREADY equals the readback and folding it would
  //   invent a difference;
  // - a rule the applier REFUSES — the whole Put is skipped, AWS keeps the
  //   previous configuration, and folding the desired side onto it would make
  //   the comparison equal, so `update()` would never be called and the skip
  //   warning would STOP.
  if (objectRules.length !== rules.length || objectRules.length === 0) return config;
  if (objectRules.some(lifecycleRuleRefused)) return config;
  const useFilterForm = lifecycleUsesFilterForm(objectRules);
  return canonicalizeItemList(config, 'Rules', (rule) =>
    effectiveLifecycleRule(rule, useFilterForm)
  );
}

/**
 * The one rule fold both sides share — the CFn-shaped bag `readLifecycle` emits
 * for the SDK rule `applyLifecycleConfiguration` builds from this rule.
 *
 * Ordered the way the wire is: the legacy singular is merged into the plural
 * BEFORE the alias fold runs, because the singular can carry the SDK day/date
 * spellings too.
 *
 * MEASURED against the REAL synthesized `s3-lifecycle` fixture templates (every
 * bucket, both phases): the recorded rule and the emitted one carry identical
 * KEYS and identical VALUES, and differ only in key ORDER — the record keeps the
 * template's, the readback uses the reverse-mapper's. That is pre-existing and
 * unchanged here (the record was always template-ordered), and it does not reach
 * `cdkd drift`, whose baseline is `observedProperties` — captured from this very
 * reverse-mapper, so both sides carry its order. It is stated because a reader
 * comparing the two by `JSON.stringify` will see a difference and should know it
 * was measured rather than missed.
 *
 * @returns `rule` BY IDENTITY when the declared rule already IS that bag, so an
 *   ordinary CFn-spelled template records byte-for-byte as before. The compare
 *   is deep and key-ORDER-insensitive for the same reason: a reordering is not a
 *   difference worth rewriting a state record for.
 */
export function effectiveLifecycleRule(
  rule: Record<string, unknown>,
  useFilterForm: boolean
): Record<string, unknown> {
  let out = foldLegacySingularTransitions(rule);
  out = canonicalizeItemList(out, 'Transitions', (t) =>
    foldTransitionDate(foldToleratedAliases(t, TRANSITION_ALIASES))
  );
  out = dropEmptyTransitionLists(out);
  out = foldLifecycleExpiration(out);
  out = foldNoncurrentVersionExpiration(out);
  out = foldLifecycleScope(out, useFilterForm);
  // `Status` is a defaulted-but-SENT member (`readConfigString(rule, 'Status',
  // 'Enabled', ...)`), and AWS reports it back on every rule — so a rule that
  // omits it is one key short of the readback. Resolved by PRESENCE, never with
  // `??`: a DECLARED-but-malformed `Status` is already screened out by
  // `lifecycleRuleRefused` above, so the only way to reach the default here is
  // the ABSENT key the rule is scoped to.
  // COMPUTED key, like {@link EVENTBRIDGE_CONFIG_KEY} and
  // {@link foldTransitionDate} — a named-member spread-and-patch in a DIFF-side
  // fold is the #1475 hand-off spelling this file avoids in three other places,
  // and it also withdraws the name from the reverse-map exclusion. Inert for
  // `Status` today; spelled consistently so the convention cannot rot.
  if (out[LIFECYCLE_STATUS_KEY] === undefined) {
    const withStatus = { ...out };
    withStatus[LIFECYCLE_STATUS_KEY] = LIFECYCLE_DEFAULT_STATUS;
    out = withStatus;
  }
  return deepSameValue(rule, out) ? rule : out;
}

/**
 * Apply a WHOLE-BLOCK fold to one top-level property on BOTH sides of a diff —
 * the {@link canonicalizeItemList} sibling for the two #1748 folds, whose unit
 * is the block rather than an item of a list.
 *
 * The COMPUTED `[key]:` write is load-bearing and must not be "tidied" into a
 * named-member spread (`{ ...out, LifecycleConfiguration: folded }`), which is
 * how this was first written. `gen-nested-key-coverage`'s write-side walk
 * recognizes a bag-derived spread-and-patch literal as a whole-blob HAND-OFF
 * (its #1475 recognizer) and records everything beneath the named path as
 * delivered whole — so naming the member here makes a DIFF-side pure function
 * mark that subtree as delivered whole, which can withdraw a literal's rescue
 * of a shape-pass `definition-member-missing` verdict (when the critic still
 * had a write pass, it also switched that pass off for the subtree). A computed
 * key names no member, which is exactly why the pre-existing folds in this file
 * are spelled that way.
 */
export function canonicalizeBlock(
  properties: Record<string, unknown>,
  key: string,
  fold: (block: unknown) => unknown
): Record<string, unknown> {
  const folded = fold(properties[key]);
  return folded === properties[key] ? properties : { ...properties, [key]: folded };
}

/**
 * Apply a per-ITEM fold to an array-valued member on BOTH sides of a diff — the
 * `canonicalizeDesiredProperties` plumbing every fold in this file shares, from
 * the top-level `Id`-keyed properties down to the nested `Rules[].Transitions[]`
 * list (the bag is the containing OBJECT, which at the top level is the property
 * bag and one level down is the rule).
 *
 * Identity-returns at every level (untouched item -> untouched array ->
 * untouched bag), and leaves a non-array property or a non-object element ALONE
 * so a malformed template still reaches the provider's own refusal rather than
 * being reshaped into something that looks valid.
 */
export function canonicalizeItemList(
  properties: Record<string, unknown>,
  key: string,
  fold: (item: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  const list = properties[key];
  if (!Array.isArray(list)) return properties;
  let changed = false;
  const mapped = list.map((element) => {
    if (!isPlainObject(element)) return element;
    const next = fold(element);
    if (next !== element) changed = true;
    return next;
  });
  return changed ? { ...properties, [key]: mapped } : properties;
}
