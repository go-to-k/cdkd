import {
  containsIntrinsic,
  findAcceptedSdkUnwired,
  findActionableSdkUnwired,
  findRoutableUnrecognizedProperties,
  findSdkUnwiredProperties,
  findUnrecognizedProperties,
  getPropertyCoverage,
  unsupportedPropertyIssueUrl,
} from '../property-coverage.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  CC_BROKEN_REASON,
  STICKY_CC_MIGRATION_EXEMPT,
  type AutoRouteHit,
  type ProviderRegistry,
} from '../provider-registry.js';

/**
 * Info-log every SDK-unwired routing decision (auto-route via CC API) and
 * warn-log every unwritten property the user explicitly opted into via
 * `--allow-unsupported-properties` (forced SDK path, the property will
 * be dropped). Does not mutate state; throws ONLY for the CC-route
 * viability guard (un-allowed SDK-unwired properties on a type Cloud Control cannot
 * manage — see `buildUnroutableSdkUnwiredMessage`).
 *
 * Issue [#614](https://github.com/go-to-k/cdkd/issues/614). Replaces the
 * pre-v0.16x throw path: SDK-unwired properties are now a routing signal, not an
 * error (except the viability guard above).
 *
 * When the optional `provisionedBy` (from existing state) is `'cc-api'`,
 * the auto-route info line is demoted to `debug` — the resource has been
 * on CC for at least one prior deploy, so the routing decision is
 * **continuation of sticky state, not a fresh auto-route**. Surfacing the
 * info line every deploy would be repetitive noise. The warn line for
 * explicit `--allow-unsupported-properties` overrides is NOT demoted —
 * that override is an active user choice for THIS deploy and should
 * surface every time.
 */
export function reportSdkUnwiredDecisions(
  this: ProviderRegistry,
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
    provisionedBy?: 'sdk' | 'cc-api' | undefined;
    /** The state record's bag — `GetProviderForInput.previousProperties`. */
    previousProperties?: Record<string, unknown> | undefined;
  }>
): void {
  for (const {
    logicalId,
    resourceType,
    properties,
    provisionedBy,
    previousProperties,
  } of resources) {
    const drops = findSdkUnwiredProperties(resourceType, properties);
    // Route-driving keys the schema snapshot does not know (issue #3713).
    // They join `autoRouted` below: they move the resource exactly as an
    // SDK-unwired property does, and `ccRouteUnavailableReason` cannot fire for them
    // because the predicate already excludes those types.
    const unrecognizedRoute = findRoutableUnrecognizedProperties(
      resourceType,
      properties,
      this.allowedUnsupportedProperties,
      previousProperties
    );

    // The two lists are NOT a partition of `drops`, and treating them as one
    // was a false warn (issue #2750). The allow set is per `<Type>:<Prop>`
    // while the ROUTE is per resource, and TWO things send a resource to
    // Cloud Control — which forwards the full property map, so the
    // allow-listed keys on it reach AWS after all and nothing is left unwritten:
    //
    //   - one UN-ALLOWED unwired property auto-routes it. `findAcceptedSdkUnwired`
    //     answers that and is empty in exactly that case — the same
    //     predicate the record write and the diff read.
    //   - a `provisionedBy: 'cc-api'` record keeps it there (rule 2), for
    //     any bag. That is `stickyCc`, and it is the SAME test
    //     `reportUnrecognizedProperties` already makes below; the exemption
    //     lookup is what keeps a type that will flip BACK to the SDK route
    //     from suppressing a warn about a property that will then be left unwritten.
    //
    // Without the second, this warn told a user with a sticky `cc-api`
    // log group that `ResourcePolicyDocument` "will be silently dropped" while Cloud
    // Control was writing it, and prescribed removing the override — a
    // no-op, since the resource was already on the route that remedy names.
    const stickyCc = provisionedBy === 'cc-api' && !STICKY_CC_MIGRATION_EXEMPT.has(resourceType);
    const overridden = stickyCc
      ? []
      : findAcceptedSdkUnwired(
          resourceType,
          properties,
          this.allowedUnsupportedProperties,
          previousProperties
        );
    const autoRoutedDrops = drops
      .map(({ property }) => property)
      .filter((property) => !this.allowedUnsupportedProperties.has(`${resourceType}:${property}`));
    const autoRouted = [...autoRoutedDrops, ...unrecognizedRoute].sort((a, b) =>
      a.localeCompare(b)
    );

    if (autoRouted.length > 0) {
      // The CC auto-route is only viable when Cloud Control can actually
      // manage the type. For a NON_PROVISIONABLE type (or a provider that
      // opted out of CC fallback) the route would fail at provisioning
      // time with an opaque error — reject pre-flight with the clear one.
      const unroutable = this.ccRouteUnavailableReason(resourceType);
      if (unroutable !== undefined) {
        throw new Error(
          safeMsg`${logicalId}: ` +
            this.buildUnroutableSdkUnwiredMessage(
              resourceType,
              drops.filter((d) => autoRouted.includes(d.property)),
              unroutable
            )
        );
      }
      const propList = autoRouted.join(', ');
      const overrideHint = autoRouted.map((p) => `${resourceType}:${p}`).join(',');
      // An unrecognized key is named as such: it may be a typo, which Cloud
      // Control will REJECT — and saying so up front is what makes that
      // failure readable as CloudFormation parity rather than a cdkd bug.
      const unrecognizedNote =
        unrecognizedRoute.length === 0
          ? ''
          : ` ${unrecognizedRoute.join(', ')} ${unrecognizedRoute.length === 1 ? 'is' : 'are'} ` +
            `not in cdkd's CFn schema snapshot: Cloud Control applies a property AWS ` +
            `published since, and rejects a misspelled one as CloudFormation does.`;
      const message =
        `${logicalId} (${resourceType}): routing via Cloud Control API ` +
        `(cdkd's SDK Provider does not yet wire ${propList} — CC API will ` +
        `forward the full property map.${unrecognizedNote} Override via ` +
        `--prefer-sdk-route ${overrideHint}.)`;
      if (provisionedBy === 'cc-api') {
        // Sticky continuation — already on CC from a prior deploy.
        // Debug-only to avoid repetitive noise on every redeploy.
        this.logger.debug(message);
      } else {
        this.logger.info(message);
      }
    }

    // Say when the user's preference went INERT, because from their side an
    // explicit instruction looks ignored (issue
    // [#3000](https://github.com/go-to-k/cdkd/issues/3000)).
    //
    // OUTSIDE the auto-route block, and with the cause chosen rather than
    // assumed, because there are TWO ways to be inert and they have opposite
    // remedies. A first cut lived inside that block and named the sibling
    // unconditionally: on a sticky resource it then printed a cause that is
    // false (rule 2 returns Cloud Control before any unwired property is consulted) and a
    // remedy that is a no-op (widening the set cannot beat a sticky record) —
    // the same shape issue [#2750](https://github.com/go-to-k/cdkd/issues/2750)
    // retired, prescribing a route the resource is already on.
    //
    // It also stayed silent in the case most likely to be reported: sticky
    // with EVERY unwired property covered, where `autoRouted` is empty, `overridden` is
    // emptied by `stickyCc`, and Cloud Control writes the values anyway.
    const named = drops
      .map(({ property }) => property)
      .filter((property) => this.allowedUnsupportedProperties.has(`${resourceType}:${property}`));
    if (named.length > 0 && (stickyCc || autoRouted.length > 0)) {
      const list = named.join(', ');
      const isAre = named.length === 1 ? 'is' : 'are';
      // STICKY wins when both hold: it is the earlier decision, so naming the
      // sibling would name a cause that is not the operative one.
      const [cause, remedy] = stickyCc
        ? [
            `this resource's state record already routes it to Cloud Control ` +
              `(provisionedBy: cc-api), which is decided before any property is consulted`,
            // NO COMMAND, deliberately — the same call the create-only
            // sentence below makes, for the same reason and against the
            // MIRROR flag. `--recreate-via-sdk-provider <LogicalId>` looks
            // like the answer and is refused in most of this branch's own
            // population: `ambiguousIntentSdk` refuses it while any unwired property
            // outside the preference is still actionable (which is exactly
            // the `stickyCc && autoRouted.length > 0` half), 17 of the types
            // carrying sdkUnwired entries are STATEFUL and need
            // `--force-stateful-recreation` on top, and neither flag can
            // address a resource inside a nested-stack child. It is also
            // DESTRUCTIVE, which a one-line remedy must not omit. A sentence
            // that has to be right about four conditions is a sentence that
            // will be wrong about one; the deploy-safety docs carry it with
            // its conditions.
            `Returning this resource to the SDK provider is a destroy-and-recreate, not a ` +
              `flag change — see https://cdkd.dev/cli-deploy-safety/. Widening ` +
              `--prefer-sdk-route alone cannot do it.`,
          ]
        : [
            `${autoRouted.join(', ')} ${autoRouted.length === 1 ? 'is' : 'are'} not covered ` +
              `by it, and one uncovered property routes the whole RESOURCE to Cloud Control`,
            `To keep the resource on its SDK provider, add ` +
              `${autoRouted.map((p) => `${resourceType}:${p}`).join(',')} to --prefer-sdk-route as well.`,
          ];
      this.logger.warn(
        `${logicalId} (${resourceType}): --prefer-sdk-route had no effect for ${list} — ` +
          `${cause}. Cloud Control forwards the full property map, so ${list} ${isAre} ` +
          `written to AWS after all. ${remedy}`
      );
    }
    if (overridden.length > 0) {
      // The REMEDY is per property, because "remove the override" is not
      // enough for a create-only one (issue #2790): with the flag gone the
      // property can only be applied by a REPLACEMENT. Where the record
      // shows cdkd itself created the resource without it
      // (`acceptedCreateOnlyDrops`), the deploy refuses that replacement
      // until it is opted into (`unwrittenCreateOnlyRefusal` in
      // `deploy-engine/update.ts`, which names the flags with their
      // conditions); an imported or older record carries no such evidence
      // and diffs unchanged. This line cannot tell the two apart, so it says
      // which case the refusal is.
      //
      // The create-only sentence deliberately prescribes NO COMMAND. The
      // obvious one, `--recreate-via-cc-api <LogicalId>`, is REFUSED by
      // `validateRecreateTargets` while this very override is still set
      // (`ambiguousIntent`), needs `--force-stateful-recreation` for the 9 of
      // these types that are stateful, and is refused outright for a provider
      // declaring `disableCcApiFallback`. A sentence that has to be right
      // about all three is a sentence that will be wrong about one; the
      // refusal carries the remedy with its conditions, and this line
      // carries only what is true unconditionally.
      //
      // And BOTH sentences are false for a type with no Cloud Control route
      // (NON_PROVISIONABLE, or a provider declaring `disableCcApiFallback`;
      // issue [#2792](https://github.com/go-to-k/cdkd/issues/2792)): with the
      // override gone the unwired property is actionable, so the next deploy REFUSES at
      // pre-flight rather than routing, and a recreate lands on the same SDK
      // provider that does not wire it. That type gets one sentence saying what
      // removing the override does, and no remedy: none applies the property.
      const createOnly = getPropertyCoverage(resourceType)?.createOnlyDrops;
      const unroutable = this.ccRouteUnavailableReason(resourceType);
      const reroutable =
        unroutable === undefined ? overridden.filter((p) => createOnly?.has(p) !== true) : [];
      const needsRecreate =
        unroutable === undefined ? overridden.filter((p) => createOnly?.has(p) === true) : [];
      const remedies: string[] = [];
      if (unroutable !== undefined) {
        remedies.push(
          `This type cannot be routed via Cloud Control API (${unroutable}), so ` +
            `removing the override makes the deploy refuse at pre-flight instead of ` +
            `rerouting; cdkd has no route that applies ` +
            `${overridden.length === 1 ? 'it' : 'them'} to this type.`
        );
      }
      if (reroutable.length > 0) {
        remedies.push(
          `Remove the override for ${reroutable.join(', ')} to route this ` +
            `resource via Cloud Control API instead.`
        );
      }
      if (needsRecreate.length > 0) {
        const one = needsRecreate.length === 1;
        remedies.push(
          `${needsRecreate.join(', ')} ${one ? 'is' : 'are'} create-only, so ` +
            `removing the override does not apply ${one ? 'it' : 'them'} in place ` +
            `-- a create-only property can only be applied by recreating the ` +
            `resource. Where cdkd created the resource without ${one ? 'it' : 'them'}, ` +
            `a deploy without the override refuses unless something else already ` +
            `forces a replacement or the recreate is opted into.`
        );
      }
      this.logger.warn(
        `${logicalId} (${resourceType}): ${overridden.join(', ')} will be ` +
          `left unwritten (--prefer-sdk-route override ` +
          `accepted). ${remedies.join(' ')}`
      );
    }

    this.reportUnrecognizedProperties(logicalId, resourceType, properties, {
      provisionedBy,
      autoRouted: autoRouted.length > 0,
      previousProperties,
    });
  }
}

/**
 * Warn about top-level template properties this type's committed CFn schema
 * snapshot does not know about, on resources that resolve to the SDK route
 * (issues [#2718](https://github.com/go-to-k/cdkd/issues/2718),
 * [#3713](https://github.com/go-to-k/cdkd/issues/3713)).
 *
 * Such a key normally ROUTES the resource through Cloud Control
 * (`findRoutableUnrecognizedProperties`), and then no warn is due: Cloud
 * Control applies it or rejects it as CloudFormation would. What stays on the
 * SDK route — and is dropped there with the deploy reporting success — falls
 * into three buckets, each named with its own reason, because a line naming
 * the wrong one misdirects the reader into the wrong fix:
 *
 * - READ-ONLY: an attribute, which no engine sets. CloudFormation ignores it
 *   too, which is why it does not route.
 * - UNROUTABLE TYPE: Cloud Control cannot take the type over
 *   (`disableCcApiFallback` / `NON_PROVISIONABLE`), so the value has no route.
 * - UNCHANGED: the state record already holds the key with this value (or
 *   a value that cannot be compared before resolution), so the resource
 *   stays on the SDK route, which does not send it. Changing it routes the
 *   resource. "Never reached AWS" would overclaim: a record `cdkd import`
 *   wrote carries the template's bag, whose value the live resource may hold.
 * - UNROUTABLE TYPE also covers a `'cc-broken'` sticky-CC exemption, whose
 *   Cloud Control handler cannot manage the type at all.
 *
 * Fires only on the SDK route. `provisionedBy: 'cc-api'` from state (minus
 * the `STICKY_CC_MIGRATION_EXEMPT` types that return to their SDK provider)
 * and a resource auto-routing this deploy both forward the full map.
 *
 * **An intrinsic value is reported as undecided.** This runs on the
 * template's RAW properties (`deploy-engine.ts` calls
 * `validateResourceProperties` pre-flight) while `getProviderFor` runs on
 * RESOLVED ones, so a recorded key whose raw value still holds an intrinsic
 * cannot be compared here. It is not announced as routing, and its warn
 * sentence says the route is decided once the value resolves — true on
 * either outcome. `getProviderFor` remains the authority.
 *
 * Suppressed per `<Type>:<Prop>` by `--prefer-sdk-route`, whose meaning
 * ("leave the property unwritten, stay on the SDK path") is exactly this case.
 */
export function reportUnrecognizedProperties(
  this: ProviderRegistry,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  route: {
    provisionedBy?: 'sdk' | 'cc-api' | undefined;
    autoRouted: boolean;
    previousProperties?: Record<string, unknown> | undefined;
  }
): void {
  const stickyCc =
    route.provisionedBy === 'cc-api' && !STICKY_CC_MIGRATION_EXEMPT.has(resourceType);
  if (stickyCc || route.autoRouted) return;

  const unrecognized = findUnrecognizedProperties(resourceType, properties).filter(
    (property) => !this.allowedUnsupportedProperties.has(`${resourceType}:${property}`)
  );
  if (unrecognized.length === 0) return;

  const coverage = getPropertyCoverage(resourceType);
  // The coverage flag is the one the routing predicate reads, so it decides
  // here too; the registry's own reason only words it.
  const unroutable =
    this.ccRouteUnavailableReason(resourceType) ??
    (STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode === 'cc-broken'
      ? CC_BROKEN_REASON
      : coverage?.ccRouteUnavailable === true
        ? "the type's SDK provider opts out of the Cloud Control fallback (disableCcApiFallback)"
        : undefined);
  // Not auto-routed and not read-only means the key did not qualify to route:
  // either the type has no Cloud Control route, or the recorded bag holds it
  // unchanged (`findRoutableUnrecognizedProperties`' baseline arm).
  const readOnly = unrecognized.filter((p) => coverage?.readOnly.has(p) === true);
  const notReadOnly = unrecognized.filter((p) => coverage?.readOnly.has(p) !== true);
  // A recorded key whose RAW value still holds an intrinsic cannot be
  // compared before resolution (see the docstring), so it gets its own
  // sentence rather than the "unchanged" one, which could be false for it.
  const undecided =
    unroutable === undefined
      ? notReadOnly.filter(
          (p) =>
            containsIntrinsic(properties?.[p]) &&
            route.previousProperties != null &&
            typeof route.previousProperties === 'object' &&
            Object.hasOwn(route.previousProperties, p)
        )
      : [];
  const rest = notReadOnly.filter((p) => !undecided.includes(p));
  const sentences: string[] = [];
  const isAre = (names: string[]) => (names.length === 1 ? 'is' : 'are');
  if (readOnly.length > 0) {
    sentences.push(
      `${readOnly.join(', ')} ${isAre(readOnly)} read-only — an attribute AWS computes, ` +
        `which no engine sets (CloudFormation ignores it too); remove it.`
    );
  }
  if (rest.length > 0 && unroutable !== undefined) {
    sentences.push(
      `${rest.join(', ')} ${isAre(rest)} not in cdkd's CFn schema snapshot, and this type ` +
        `cannot be routed via Cloud Control API (${unroutable}), so cdkd has no route that ` +
        `applies ${rest.length === 1 ? 'it' : 'them'}. If it is a property AWS published ` +
        `since the snapshot, please report it: ` +
        `${unsupportedPropertyIssueUrl(resourceType, rest[0]!)}.`
    );
  } else if (rest.length > 0) {
    sentences.push(
      `${rest.join(', ')} ${isAre(rest)} not in cdkd's CFn schema snapshot and unchanged ` +
        `since this resource was deployed on the SDK route, so it stays there and cdkd ` +
        `does not send ${rest.length === 1 ? 'it' : 'them'}. ` +
        `Changing ${rest.length === 1 ? 'it' : 'one'} routes the resource via Cloud Control ` +
        `API, which applies a property AWS published since the snapshot and rejects a ` +
        `misspelled one, as CloudFormation does.`
    );
  }
  if (undecided.length > 0) {
    sentences.push(
      `${undecided.join(', ')} ${isAre(undecided)} not in cdkd's CFn schema snapshot and ` +
        `${undecided.length === 1 ? 'its value holds' : 'their values hold'} an intrinsic, ` +
        `so the route is decided once it resolves: a value unchanged since the SDK-route ` +
        `deploy stays there and is not sent, and a changed one routes via Cloud Control API.`
    );
  }
  if (sentences.length === 0) return;
  const overrideHint = unrecognized.map((p) => `${resourceType}:${p}`).join(',');
  this.logger.warn(
    `${logicalId} (${resourceType}): ${unrecognized.length === 1 ? 'a property' : 'properties'} ` +
      // Only the undecided bucket can still reach AWS; any other bucket present
      // makes the definite claim true for at least one named property.
      `${readOnly.length + rest.length > 0 ? 'will NOT' : 'may not'} reach AWS — the deploy ` +
      `will still report success. ${sentences.join(' ')} ` +
      `If the drop is intended — an addPropertyOverride escape hatch — silence this via ` +
      `--prefer-sdk-route ${overrideHint}.`
  );
}

/**
 * Pure-functional discovery of every resource whose template uses one or
 * more SDK-unwired properties that are NOT in the
 * `--allow-unsupported-properties` allow set — i.e. every resource that
 * `getProviderFor` would auto-route via Cloud Control. Returned
 * entries carry the SDK-unwired property names so plan / diff renderers
 * can show `[via CC API: Body]`.
 *
 * Does NOT log or throw. Use {@link reportSdkUnwiredDecisions} for the
 * side-effecting info / warn surface.
 */
export function findAutoRouteHits(
  this: ProviderRegistry,
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
    /** The state record's bag — `GetProviderForInput.previousProperties`. */
    previousProperties?: Record<string, unknown> | undefined;
  }>
): AutoRouteHit[] {
  const hits: AutoRouteHit[] = [];
  for (const { logicalId, resourceType, properties, previousProperties } of resources) {
    const actionable = findActionableSdkUnwired(
      resourceType,
      properties,
      this.allowedUnsupportedProperties,
      previousProperties
    );
    if (actionable.length === 0) continue;
    hits.push({
      logicalId,
      resourceType,
      properties: actionable.map((d) => d.property),
    });
  }
  return hits;
}
