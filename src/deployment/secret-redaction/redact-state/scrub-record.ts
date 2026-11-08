import { isSingleDynamicReferenceToken } from '../rules.js';
import { SECRET_MASK, type RecordedSecretValues } from '../pairs.js';
import { redactForState, redactAtProvenance } from '../context.js';
import { attributeIdCopiesOf, physicalNameCopiesOf } from '../physical-name-copies.js';

/** The same-generation claim per bag {@link scrubResourceRecord} walks; absent is `unproven`. */
export interface ScrubGenerationClaims {
  readonly properties?: 'same-generation' | 'unproven';
  readonly observed?: 'same-generation' | 'unproven';
}

/**
 * Redact resolved secret plaintext out of one resource state record's
 * `properties` / `attributes` / `observedProperties`, replacing each secret
 * value with its unresolved expression. Returns a NEW record when any field
 * changed, or the input by identity when there are no secrets — so callers can
 * detect a no-op cheaply. Shared by the deploy engine's save choke point and
 * the `cdkd scrub` command so both scrub the same three fields identically.
 *
 * `observedProvenance` overrides the provenance the `observedProperties` walk
 * would otherwise DERIVE from whether a `sourceProperties` bag was supplied. Exactly
 * one caller needs it and the reason is not obvious, so it is a parameter
 * rather than another derivation: `cdkd scrub` has already repositioned
 * `properties` against TODAY's template by the time it calls this, so the
 * "record's own properties" this walk falls back to are no longer the same
 * GENERATION as the observed bag beside them (issue #1917 review). Left
 * unspecified, the derivation below is right for every other caller, whose
 * `properties` reach this function untouched.
 *
 * That derivation's fail-closed arm asks TWO questions, not one — the secrets
 * map must be EMPTY and the observed bag must be one THIS RUN produced (issue
 * [#2906](https://github.com/go-to-k/cdkd/issues/2906)), the second being
 * `claims.observed`. A caller re-writing a PRIOR generation's
 * `observedProperties` unchanged therefore keeps it intact rather than masking
 * positions it cannot pair.
 *
 * `claims` is the CALLER's same-generation claim per bag (go-to-k/cdkd#5047):
 * `properties` (read only when `sourceProperties` is given; without one that
 * walk is a value scan) and `observed`. Absent means `unproven`. This function
 * reads no mark: a writer holding a bag the deploy engine marked
 * (`propertiesToRecord`, `drainObservedCaptures`) states what the mark says at
 * its call site.
 */
export function scrubResourceRecord<
  T extends {
    properties: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    observedProperties?: Record<string, unknown>;
  },
>(
  record: T,
  secrets: RecordedSecretValues,
  sourceProperties?: Record<string, unknown>,
  observedProvenance?: 'state-readback' | 'state-cross-generation',
  claims: ScrubGenerationClaims = {}
): T {
  const propertiesClaimed = claims.properties === 'same-generation';
  const observedClaimed = claims.observed === 'same-generation';
  // NOT `sourceProperties === undefined`: an UNCHANGED resource has neither a
  // secrets map nor a template bag, and its observed bag is exactly what needs
  // redacting (issue #1900) — so an early return gated on those two alone made
  // that half dead code.
  if (secrets.size === 0 && sourceProperties === undefined && !record.observedProperties) {
    return record;
  }
  const next = { ...record };
  next.properties =
    sourceProperties === undefined
      ? redactForState(record.properties, { provenance: 'value-scan', secrets })
      : redactAtProvenance(
          record.properties,
          secrets,
          sourceProperties,
          'template-derived',
          propertiesClaimed
        );
  if (record.attributes) {
    // go-to-k/cdkd#4849: a copy of the record's OWN physical id among its
    // attributes (an SNS topic's `TopicArn`, a queue's `QueueUrl`) stays as
    // the id does, in plaintext: a resource NAMED from a `NoEcho` value would
    // otherwise store the attribute as `***`, and a later `Fn::GetAtt` reader
    // could not resolve it. Nothing new reaches state, since `physicalId` is
    // beside it. Another value containing the secret (`TopicName`, unless the
    // physical id IS the value) is no copy of the id and stays masked. The
    // ids a nested row's outputs copy (`attributeIdCopiesOf`) join it here.
    const ownId = (record as { physicalId?: unknown }).physicalId;
    const ids = [...(attributeIdCopiesOf.get(secrets) ?? [])];
    if (typeof ownId === 'string' && ownId !== '') ids.push(ownId);
    const attributes = record.attributes;
    next.attributes =
      ids.length > 0
        ? withPhysicalNameCopies(secrets, ids, () =>
            redactForState(attributes, { provenance: 'value-scan', secrets })
          )
        : redactForState(attributes, { provenance: 'value-scan', secrets });
  }
  // go-to-k/cdkd#5498: the attempted item names (an index name, a tag key)
  // can be secret-derived, so they take the value scan, as `attributes` do. A
  // name rewritten to its expression or `***` never matches a live item
  // (`isUsableAttemptedName`), so it is kept, never removed.
  const attemptedItems = (record as { unsettledItems?: unknown }).unsettledItems;
  if (
    typeof attemptedItems === 'object' &&
    attemptedItems !== null &&
    !Array.isArray(attemptedItems)
  ) {
    (next as { unsettledItems?: unknown }).unsettledItems = redactForState(
      attemptedItems as Record<string, unknown>,
      { provenance: 'value-scan', secrets }
    );
  }
  if (record.observedProperties) {
    // `observedProperties` is a live AWS readback, so its OWN source of truth is
    // the record's (already redacted) `properties` — a member whose stored value
    // is an expression must not be overwritten by the plaintext AWS echoes back
    // (issue #1900). When a `sourceProperties` bag was supplied it is the
    // template, which is the better source; otherwise fall back to the record's
    // own properties, which is what makes an UNCHANGED resource redactable at
    // all.
    // `next.properties`, not `record.properties`: the just-redacted bag is the
    // one that actually holds expressions. On the `cdkd scrub` path the original
    // is still plaintext, so using it would degrade this to the value scan.
    // The RULES differ by which source we ended up with, which is the whole
    // point of them being separate flags: a TEMPLATE source carries public ssm
    // expressions (so no blanket trust) and is a different generation from this
    // bag (so it may not overwrite a leaf that already holds an expression),
    // while the record's own untouched properties are neither (so the #1900
    // no-secrets-map path works). Neither descends arrays POSITIONALLY, because
    // this bag came back from AWS and AWS does not preserve list order — both
    // still descend by an element IDENTITY KEY, which is order-independent
    // (issue #1915).
    //
    // `observedProvenance` wins when the caller supplied one, because a caller can
    // know something this derivation cannot: that it already MOVED
    // `next.properties` to another generation. See the parameter's doc.
    next.observedProperties = redactAtProvenance(
      record.observedProperties,
      secrets,
      sourceProperties ?? next.properties,
      observedProvenance ??
        // This branch redacts `observedProperties` SPECIFICALLY, so the
        // DESTINATION is known here and the fail-closed refusal of issue #2852
        // may apply — which is how the deploy's `drainObservedCaptures`
        // baseline gets it without a call-site change.
        //
        // `secrets.size === 0` narrows it further, and the reason is a
        // MEASUREMENT rather than symmetry with the destination flag. The
        // rollback replay's trailing scrub always arrives with a POPULATED
        // map, and the deploy JOURNAL's `previousState` no longer consults
        // this derivation at all — `redactOperationsForJournal` passes the
        // readback constant explicitly (issue
        // [#2886](https://github.com/go-to-k/cdkd/issues/2886)), because its
        // empty-map ops took the fail-closed arm here and a rollback restore
        // carried the resulting masks into the persisted record. Both are
        // REPLAYED baselines: the bag is a previous generation's readback, and
        // masking a position there poisons the record a rollback then persists,
        // for a leaf the scan had every chance to name.
        //
        // `secrets.size === 0` is NOT SUFFICIENT ON ITS OWN, and the sentence
        // that used to end this paragraph — "what is left on this empty-map arm
        // is exactly the deploy persist choke point's #1900 walk, the fresh
        // drained readback the refusal exists for" — was FALSE (issue
        // [#2906](https://github.com/go-to-k/cdkd/issues/2906)). The same
        // empty-map arm is also taken by `redactStateForPersist` on every
        // FAILURE-PATH and intermediate save, for a resource whose resolve
        // threw before recording anything: there the observed bag is the PRIOR
        // generation's `observedProperties`, read out of `state.json` and being
        // RE-WRITTEN UNCHANGED. Masking an unpairable position in THAT bag —
        // an array AWS reordered, an identity key AWS normalised — replaces a
        // correct persisted baseline with {@link SECRET_MASK} and produces
        // permanent phantom drift no `cdkd drift` run clears, until the next
        // SUCCESSFUL deploy's `drainObservedCaptures` overwrites the record.
        // Exactly the two REPLAYED-baseline cases above, one writer over.
        //
        // So the arm asks the question those two answer by construction: is
        // this bag one THIS RUN PRODUCED? The caller's `claims.observed`
        // answers it — the deploy engine states `markSameGenerationBag`'s
        // mark there — and the mark is put on precisely the bag the refusal
        // exists for — `DeployEngine.observedCapture.drainObservedCaptures` marks EVERY drained
        // READBACK, and it is the only writer of `observedProperties` on the
        // deploy path, so a bag arriving here UNMARKED is a previous
        // generation's by elimination. `redactStateForPersist` reads the mark
        // off the very object drain installed, before any copy. The one unmarked bag that drain installs is the
        // masked-baseline re-capture (issue #3595): a previous generation's
        // baseline with some masks replaced by the record's own references, so
        // it holds nothing this run read from AWS and the argument below
        // covers it unchanged.
        //
        // Failing OPEN on an unmarked bag is safe for the reason the two
        // replayed cases give and for no other: the bag ALREADY SITS in
        // `state.json` verbatim, so a mask protects no reader who is not
        // already exposed, while it destroys a baseline that was intact. A
        // caller whose bag is fresh but which cannot mark it should state
        // `state-baseline` itself (`redactForState`), the way
        // `cdkd state refresh-observed` and `cdkd import`'s observed capture
        // already do — neither reaches this derivation at all.
        //
        // The evidence is per-VALUE, not per-map, and this comment said
        // otherwise until a review measured it: a rotated secret, or a
        // pre-GHSA legacy leaf, is not a key of THIS pass's map, so a populated
        // map does not mean every plaintext in the bag was covered. What the
        // narrowing buys is not "nothing left to protect" — it is that the
        // value already sits in `state.json` (`cdkd scrub` is its repairer) and
        // a mask here would be a fresh, permanent hole in a baseline
        // `cdkd drift --accept` then refuses for the life of the record.
        //
        // It is safe to key on the map HERE, unlike inside the walk, precisely
        // because the destination is already settled: the question left is
        // evidence, not where the bag lands.
        //
        // A caller that supplied `observedProvenance` keeps its own choice.
        (sourceProperties !== undefined
          ? 'template-sourced'
          : secrets.size === 0 && observedClaimed
            ? 'state-baseline'
            : 'state-readback'),
      // The same claim, as the walk's generation claim, whatever the provenance.
      observedClaimed
    );
  }
  return next;
}

/**
 * `run` with the pass's physical-name copies HIDDEN (go-to-k/cdkd#4810): what
 * the persist walk wrote for `secrets` before that rule, the LEGACY form. The
 * side set is restored before returning, also on a throw; the walk is
 * synchronous, so no other reader of the bag sees it missing.
 */
export function withoutPhysicalNameCopies<T>(secrets: RecordedSecretValues, run: () => T): T {
  const names = physicalNameCopiesOf.get(secrets);
  if (names === undefined) return run();
  physicalNameCopiesOf.delete(secrets);
  try {
    return run();
  } finally {
    physicalNameCopiesOf.set(secrets, names);
  }
}

/**
 * `run` with `ids` added to the pass's physical-name copies for its duration
 * only (go-to-k/cdkd#4810), for a caller whose bag also feeds a reader that
 * must keep rewriting them. The previous side set is restored afterwards,
 * also on a throw; the walk is synchronous.
 */
export function withPhysicalNameCopies<T>(
  secrets: RecordedSecretValues,
  ids: readonly string[],
  run: () => T
): T {
  const previous = physicalNameCopiesOf.get(secrets);
  const names = new Set(previous);
  for (const id of ids) if (id !== '') names.add(id);
  physicalNameCopiesOf.set(secrets, names);
  try {
    return run();
  } finally {
    if (previous === undefined) physicalNameCopiesOf.delete(secrets);
    else physicalNameCopiesOf.set(secrets, previous);
  }
}

/**
 * A RECORD written before go-to-k/cdkd#4810 holds a reader's copy of a read
 * physical id in its rewritten, `{{resolve:` form. Returns `stored` with each
 * leaf that holds exactly what `legacy` (today's value persisted the old way)
 * holds at the same position, where `current` (the persisted form now) holds
 * something else, replaced by `current`'s leaf: the same value, so the
 * comparison reads it as unchanged and the record is repaired. POSITION-wise,
 * so a leaf the template spells as the literal reference (which both forms
 * persist alike) is never touched. Returns `stored` by identity when nothing
 * changed.
 */
export function repairPhysicalNameCopyLeaves(
  stored: unknown,
  legacy: unknown,
  current: unknown
): unknown {
  if (typeof stored === 'string') {
    return typeof legacy === 'string' &&
      typeof current === 'string' &&
      stored === legacy &&
      current !== legacy
      ? current
      : stored;
  }
  if (Array.isArray(stored)) {
    if (!Array.isArray(legacy) || !Array.isArray(current)) return stored;
    if (legacy.length !== stored.length || current.length !== stored.length) return stored;
    let changed = false;
    const out = stored.map((item, i) => {
      const next = repairPhysicalNameCopyLeaves(item, legacy[i], current[i]);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : stored;
  }
  if (stored !== null && typeof stored === 'object') {
    if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) return stored;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return stored;
    const l = legacy as Record<string, unknown>;
    const c = current as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!Object.hasOwn(l, key) || !Object.hasOwn(c, key)) continue;
      const next = repairPhysicalNameCopyLeaves(value, l[key], c[key]);
      if (next !== value) {
        out ??= { ...(stored as Record<string, unknown>) };
        out[key] = next;
      }
    }
    return out ?? stored;
  }
  return stored;
}

/**
 * The `[legacy, plaintext]` spellings of each physical id the pass read whose
 * old persist form EMBEDS a reference in surrounding text
 * (`https://sqs.../{{resolve:...}}`), for repairing a record leaf no desired
 * value stands beside (a provider-recorded attribute such as an SQS queue
 * policy's `cdkd:WrittenQueues`). A copy rewritten WHOLE into a single token
 * is left out: a leaf equal to a token can be a literal reference the
 * template spells. `legacySecrets` names the plaintexts the old walk knew:
 * `secrets` itself, or a map resolved from the RECORD's own references when
 * today's resolution no longer holds the one that rewrote it.
 */
export function embeddedPhysicalNameRewrites(
  secrets: RecordedSecretValues,
  legacySecrets: RecordedSecretValues = secrets
): Array<readonly [string, string]> {
  const names = physicalNameCopiesOf.get(secrets);
  if (names === undefined) return [];
  const pairs: Array<readonly [string, string]> = [];
  withoutPhysicalNameCopies(legacySecrets, () => {
    for (const name of names) {
      const legacy = redactForState(name, { provenance: 'value-scan', secrets: legacySecrets });
      if (
        typeof legacy === 'string' &&
        legacy !== name &&
        legacy.includes('{{resolve:') &&
        !isSingleDynamicReferenceToken(legacy) &&
        !legacy.includes(SECRET_MASK)
      ) {
        pairs.push([legacy, name]);
      }
    }
  });
  return pairs;
}

/** `value` with every string leaf's `legacy` spellings replaced by their plaintext. */
export function replaceEmbeddedPhysicalNameRewrites(
  value: unknown,
  pairs: ReadonlyArray<readonly [string, string]>
): unknown {
  if (pairs.length === 0) return value;
  if (typeof value === 'string') {
    let next = value;
    for (const [legacy, name] of pairs) next = next.split(legacy).join(name);
    return next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = replaceEmbeddedPhysicalNameRewrites(item, pairs);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = replaceEmbeddedPhysicalNameRewrites(item, pairs);
      if (next !== item) {
        out ??= { ...(value as Record<string, unknown>) };
        out[key] = next;
      }
    }
    return out ?? value;
  }
  return value;
}

/**
 * `stored` with each string leaf repaired by `pairs` ONLY where the repaired
 * leaf then equals `target`'s leaf at the same position (go-to-k/cdkd#4810):
 * the legacy spelling was the whole difference. Any other leaf, and any leaf
 * whose repair would not reach `target`, is left as it is. Returns `stored`
 * by identity when nothing changed.
 */
export function repairEmbeddedPhysicalNamesTowards(
  stored: unknown,
  target: unknown,
  pairs: ReadonlyArray<readonly [string, string]>
): unknown {
  if (pairs.length === 0) return stored;
  if (typeof stored === 'string') {
    if (typeof target !== 'string' || stored === target) return stored;
    const repaired = replaceEmbeddedPhysicalNameRewrites(stored, pairs);
    return repaired === target ? repaired : stored;
  }
  if (Array.isArray(stored)) {
    if (!Array.isArray(target) || target.length !== stored.length) return stored;
    let changed = false;
    const out = stored.map((item, i) => {
      const next = repairEmbeddedPhysicalNamesTowards(item, target[i], pairs);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : stored;
  }
  if (stored !== null && typeof stored === 'object') {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return stored;
    const t = target as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!Object.hasOwn(t, key)) continue;
      const next = repairEmbeddedPhysicalNamesTowards(value, t[key], pairs);
      if (next !== value) {
        out ??= { ...(stored as Record<string, unknown>) };
        out[key] = next;
      }
    }
    return out ?? stored;
  }
  return stored;
}
