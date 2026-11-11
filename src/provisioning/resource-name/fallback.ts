import { generateResourceName } from './generate.js';
import { FALLBACK_NAME_RULES, type GeneratedNameRule } from './fallback-rules.js';
import { stackScopeStore } from './stack-scope.js';

/** Input a generated name needs beyond the logical id. */
export interface GeneratedNameInput {
  /** A directory bucket's zone id (`use1-az5`), which its name ends with. */
  zoneId?: string;
  /** The resource's properties, for a rule's `reservedLength` and `nameSuffix`. */
  properties?: Record<string, unknown>;
}

/** The current scope is a stack with an instance id (not a legacy stack). */
function scopeHasStackInstanceId(): boolean {
  return stackScopeStore.getStore()?.stackInstanceId !== undefined;
}

/** `rule`'s name for `logicalId`, or `undefined` when a zone suffix has no zone id. */
function deriveRuleName(
  rule: GeneratedNameRule,
  logicalId: string,
  input: GeneratedNameInput
): string | undefined {
  if (rule.zoneSuffix === true) {
    if (input.zoneId === undefined || input.zoneId === '') return undefined;
    const suffix = `--${input.zoneId}--x-s3`;
    const base = generateResourceName(logicalId, {
      ...rule.options,
      maxLength: rule.options.maxLength - suffix.length,
    });
    return `${base}${suffix}`;
  }
  const suffix = rule.nameSuffix?.(input.properties ?? {}) ?? '';
  const reserved = (rule.reservedLength?.(input.properties ?? {}) ?? 0) + suffix.length;
  const options =
    reserved > 0 ? { ...rule.options, maxLength: rule.options.maxLength - reserved } : rule.options;
  const name = `${rule.prefix ?? ''}${generateResourceName(logicalId, options)}${suffix}`;
  const refused = rule.refusedPrefix;
  if (refused !== undefined && name.toLowerCase().startsWith(refused.toLowerCase())) {
    return `${name.slice(0, refused.length - 1)}${name.slice(refused.length)}`;
  }
  return name;
}

/**
 * The name an SDK provider generates for an un-named `resourceType` resource
 * (go-to-k/cdkd#5095): the same name {@link applyDefaultNameForFallback} fills
 * for a Cloud Control create, except where `legacy` keeps a legacy stack's
 * SDK name. Throws for a type with no rule, or a directory bucket without
 * `input.zoneId`: both are cdkd bugs.
 */
export function generatedNameFor(
  resourceType: string,
  logicalId: string,
  input: GeneratedNameInput = {}
): string {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule === undefined) {
    throw new Error(`cdkd internal error: ${resourceType} has no generated-name rule`);
  }
  // Not before the state read: `generateResourceName` refuses that scope.
  if (
    rule.legacy?.sdk === 'logicalId' &&
    !scopeHasStackInstanceId() &&
    stackScopeStore.getStore()?.beforeStateRead !== true
  ) {
    return logicalId;
  }
  const name = deriveRuleName(rule, logicalId, input);
  if (name === undefined) {
    throw new Error(`cdkd internal error: the generated ${resourceType} name needs a zone id`);
  }
  return name;
}

/**
 * The object holding `rule`'s name property in `properties`: `properties`
 * itself, or for a `nestedIn` rule that property's object, `undefined` when it
 * is not one.
 */
function nameContainer(
  rule: GeneratedNameRule,
  properties: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (rule.nestedIn === undefined) return properties;
  const nested = properties[rule.nestedIn];
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

/**
 * The zone id a directory bucket's `LocationName` names (`use1-az5`, or a
 * Local Zone's `usw2-lax1-az1`; a trailing `--x-s3` is accepted, as the SDK
 * provider accepts it), or `undefined` for anything else, such as an
 * Availability Zone NAME, which only an EC2 call could turn into an id.
 */
function directoryBucketZoneId(properties: Record<string, unknown>): string | undefined {
  const location = properties['LocationName'];
  if (typeof location !== 'string') return undefined;
  const zone = location.replace(/--x-s3$/, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-az[0-9]+$/.test(zone) ? zone : undefined;
}

/**
 * Apply default name generation for CC API fallback.
 *
 * When a resource doesn't have an explicit name property set, fills the name
 * its SDK provider generates ({@link generatedNameFor}, go-to-k/cdkd#5095),
 * so the resource is named the same on either route. A legacy stack keeps
 * the Cloud Control name `legacy.cloudControl` records, which may be none.
 *
 * A directory bucket whose `LocationName` is not a zone id has no name to
 * fill: `underivable: 'refuse'` (a create) throws, naming the fix, rather than
 * send a name AWS rejects; `'omit'` (a caller that only reads the name, or an
 * update, which takes it back out) returns `properties` unchanged.
 *
 * @param logicalId Logical ID from the template
 * @param resourceType CloudFormation resource type
 * @param properties Resource properties (will not be mutated)
 * @returns Properties with default name applied if needed, or original properties if no rule exists
 */
export function applyDefaultNameForFallback(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  underivable: 'refuse' | 'omit' = 'refuse'
): Record<string, unknown> {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (!rule) return properties;

  // A nested name needs its container: without one (a Glue connection's
  // required `ConnectionInput`) there is nothing to fill, and Cloud Control
  // reports the missing property.
  const container = nameContainer(rule, properties);
  if (container === undefined) return properties;

  // If the name property is already set, no need to generate
  if (container[rule.nameProperty]) return properties;

  let generatedName: string | undefined;
  const legacy = scopeHasStackInstanceId() ? undefined : rule.legacy?.cloudControl;
  if (legacy === 'none') return properties;
  if (legacy !== undefined) {
    generatedName = generateResourceName(logicalId, legacy);
  } else {
    const zoneId = rule.zoneSuffix === true ? directoryBucketZoneId(properties) : undefined;
    generatedName = deriveRuleName(rule, logicalId, {
      properties,
      ...(zoneId !== undefined && { zoneId }),
    });
  }
  if (generatedName === undefined) {
    if (underivable === 'omit') return properties;
    const location =
      properties['LocationName'] === undefined
        ? 'the resource declares no LocationName'
        : 'its LocationName is not a zone id such as use1-az5';
    throw new Error(
      `${logicalId} (${resourceType}): cdkd cannot generate a ${rule.nameProperty} for the ` +
        `Cloud Control create. A directory bucket's name must end with --<zone id>--x-s3, and ` +
        `${location}. Set LocationName to the zone id, or declare ${rule.nameProperty}.`
    );
  }

  if (rule.nestedIn !== undefined) {
    return {
      ...properties,
      [rule.nestedIn]: { ...container, [rule.nameProperty]: generatedName },
    };
  }
  return {
    ...properties,
    [rule.nameProperty]: generatedName,
  };
}

/**
 * The name property {@link applyDefaultNameForFallback} fills for
 * `resourceType`, or `undefined` when it fills none.
 *
 * Read by its two siblings in this file, never by a caller outside it:
 * {@link withoutGeneratedFallbackName}, which the deploy engine calls from its
 * Cloud Control UPDATE path, and {@link explicitNamePropertyFor}, which layers
 * the adoption-only table on top. The UPDATE path must NOT send the generated
 * name (issue #3174). The name only matters to a CREATE: an
 * update is a JSON Patch against the recorded bag, which holds the template's
 * resolved properties and so never carries a generated name. Injecting one
 * there makes every update patch `add` the name — harmless while the live name
 * equals the generated one. For a resource imported under any other name it is
 * a real change: refused where the name is create-only (as it is for
 * `AWS::Lambda::CapacityProvider`), and a RENAME where the type accepts the
 * update (`AWS::Cognito::UserPool`'s `UserPoolName`, for one).
 */
/** Every type {@link applyDefaultNameForFallback} names (for the test that holds each to its limit). */
export function fallbackNameRuleTypes(): string[] {
  return Object.keys(FALLBACK_NAME_RULES);
}

export function fallbackNamePropertyFor(resourceType: string): string | undefined {
  const rule = FALLBACK_NAME_RULES[resourceType];
  // A nested name is no top-level property: a caller reading one finds none.
  return rule?.nestedIn === undefined ? rule?.nameProperty : undefined;
}

/**
 * Where {@link applyDefaultNameForFallback} puts `resourceType`'s name: the
 * top-level property, or `[container, property]` for a nested one
 * (`['ConnectionInput', 'Name']`), or `undefined` when it fills none.
 */
export function fallbackNamePathFor(resourceType: string): readonly string[] | undefined {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule === undefined) return undefined;
  return rule.nestedIn === undefined ? [rule.nameProperty] : [rule.nestedIn, rule.nameProperty];
}

/**
 * `prepared` with the name {@link applyDefaultNameForFallback} GENERATED into
 * it taken back out — the bag the deploy engine hands a Cloud Control UPDATE
 * (issue #3174; why an update must not carry it is on
 * {@link fallbackNamePropertyFor}).
 *
 * The name counts as generated exactly when the fill would have produced it:
 * the type has a rule, `resolvedProps` leaves the property falsy (the fill's
 * own test, so an empty string is generated over too), and `prepared` carries
 * it. The property then goes back to what `resolvedProps` holds: deleted when
 * the template has no such key, the template's own falsy value when it does,
 * so the update's desired side agrees with the template on this key.
 * Otherwise `prepared` is returned by identity. Neither input is mutated.
 */
export function withoutGeneratedFallbackName(
  resourceType: string,
  resolvedProps: Record<string, unknown>,
  prepared: Record<string, unknown>
): Record<string, unknown> {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule?.nestedIn !== undefined) {
    // The same test one level down, restoring the container's own key.
    const outer = rule.nestedIn;
    const resolvedInner = nameContainer(rule, resolvedProps);
    const preparedInner = nameContainer(rule, prepared);
    if (resolvedInner === undefined || preparedInner === undefined) return prepared;
    const inner = withoutGeneratedFallbackNameAt(rule.nameProperty, resolvedInner, preparedInner);
    return inner === preparedInner ? prepared : { ...prepared, [outer]: inner };
  }
  const nameProperty = fallbackNamePropertyFor(resourceType);
  if (nameProperty === undefined) return prepared;
  return withoutGeneratedFallbackNameAt(nameProperty, resolvedProps, prepared);
}

/** {@link withoutGeneratedFallbackName} for one object and its name key. */
function withoutGeneratedFallbackNameAt(
  nameProperty: string,
  resolvedProps: Record<string, unknown>,
  prepared: Record<string, unknown>
): Record<string, unknown> {
  if (resolvedProps[nameProperty] || !(nameProperty in prepared)) {
    return prepared;
  }
  const restored = { ...prepared };
  if (nameProperty in resolvedProps) {
    restored[nameProperty] = resolvedProps[nameProperty];
  } else {
    delete restored[nameProperty];
  }
  return restored;
}

/**
 * The template property that supplies an explicit physical name for
 * `resourceType`, or `undefined` when cdkd knows of none (issue #2934).
 *
 * Read by the orphan-adoption pre-pass, where it decides TWO things. It
 * answers whether THIS template hands the resource a name or lets cdkd generate
 * one — and, because an unknown type answers `undefined`, it is also the
 * pre-pass's ALLOW-LIST: a type absent from both tables is NOT adopted at all.
 *
 * That second role inverts what an earlier version of this doc described. It
 * said an unknown type reads as "cdkd names this" and adoption proceeds, whose
 * failure mode is a REPLACEMENT that destroys a resource `DeletionPolicy:
 * Retain` preserved — three review rounds each found one more type reaching it.
 * Now an absent type costs a missed adoption (go-to-k/cdkd#2916's diagnosis
 * still prints) rather than a deletion, so the tables may be incomplete in the
 * safe direction only.
 *
 * **An entry here ADMITS a type to adoption**, as does a generated-name rule
 * not marked `notAdopted`. Before adding one, check the
 * three tests in `ADOPTION_REFUSED_TYPES` (`src/deployment/orphan-adoption.ts`)
 * — create mints a new resource instead of colliding, `update()` refuses, the
 * resulting replacement destroys the retained copy. A type meeting all three
 * belongs in THAT set even if it is named here; `AWS::Lambda::LayerVersion` is
 * exactly that shape and `AWS::ECS::TaskDefinition` is kept there as a belt
 * against a future `Family` entry.
 */
export function explicitNamePropertyFor(resourceType: string): string | undefined {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule !== undefined && rule.notAdopted !== true) return rule.nameProperty;
  return ADOPTION_ONLY_NAME_PROPERTIES[resourceType];
}

/**
 * Name properties known to the ADOPTION guard but not to
 * {@link FALLBACK_NAME_RULES} (issue #2934): a name cdkd never generates.
 *
 * A separate table on purpose: `FALLBACK_NAME_RULES` decides what cdkd GENERATES
 * for a Cloud Control create, so adding an entry there changes the name every
 * later create of that type uses; an existing resource keeps its name, because
 * the Cloud Control update path does not send a generated one (issue #3174),
 * and an SDK provider's update never had one to send. This table
 * answers a strictly narrower question, "does the template hand this resource
 * a name", and generates nothing. An entry here still ADMITS its type to
 * adoption exactly as one there does, so it needs the same three-test check.
 *
 * What a missing or wrong entry costs, in either table. An ABSENT type is refused outright — the
 * empty-`nameProperties` arm in `orphan-adoption.ts` runs BEFORE
 * `templateStillDeclares` — costing a missed adoption, with
 * go-to-k/cdkd#2916's diagnosis still printing. A WRONG entry is the live
 * hazard: a non-empty list clears the empty-list arm, `templateStillDeclares` then
 * looks for a property the template does not use, so an explicit name reads as
 * "no explicit name", the record is adopted, and the diff turns the create-only
 * name into a REPLACE that deletes the resource being rescued. Supplying a name
 * is the natural user move after that diagnosis, so this is a reachable path,
 * not a theoretical one.
 *
 * `AWS::Budgets::Budget` is deliberately absent rather than forgotten: its name
 * is NESTED (`Budget.BudgetName`, create-only), which neither this flat table
 * nor `templateStillDeclares`' top-level property read can express, so adoption
 * of that type is unguarded today — go-to-k/cdkd#2943 carries it.
 *
 * `AWS::ECS::TaskDefinition` was added here and REMOVED again, which is worth
 * recording: its physical id is the revision ARN rather than a
 * `generateResourceName` output, so the by-construction premise this whole
 * guard rests on is false for it and an entry here could never match. It is
 * refused by the adoption pre-pass instead — and the ALLOW-LIST gate is what
 * refuses it: its generated-name rule is `notAdopted`, so it never reaches
 * adoption at all.
 * `ADOPTION_REFUSED_TYPES` in `src/deployment/orphan-adoption.ts` carries it as
 * a BELT against a future entry here (named rather than `{@link}`-ed: this
 * module does not import it, so the link would render as dead text).
 *
 * `AWS::Events::EventBus` lives here since it lost its generated-name rule
 * (go-to-k/cdkd#5095: its `Name` is required, so nothing generates it); its
 * admission to adoption is unchanged.
 */
const ADOPTION_ONLY_NAME_PROPERTIES: Record<string, string> = {
  'AWS::Events::EventBus': 'Name',
};

/**
 * go-to-k/cdkd#2762: properties that fix a resource's name without being its
 * name property, so a template declaring one names the resource as
 * `explicitNamePropertyFor`'s does. `BucketNamePrefix` sends exactly
 * `<prefix>-<account>-<region>-an`.
 */
export function alternateNamePropertiesFor(resourceType: string): readonly string[] {
  return resourceType === 'AWS::S3::Bucket' ? ['BucketNamePrefix'] : [];
}
