/**
 * Healing a STALE attribute map on a `Fn::GetAtt` cache miss (issue
 * [#1852](https://github.com/go-to-k/cdkd/issues/1852)).
 *
 * A state record's `attributes` is written by the provider's create / update,
 * and the deploy engine's no-change skip never re-runs the provider. So a
 * record written by a binary OLDER than the one that started recording an
 * attribute (`AWS::SSM::Parameter.Arn`, `AWS::RDS::DBSubnetGroup.DBSubnetGroupArn`)
 * — or written while AWS had not assigned the value yet (a `--no-wait`
 * `DBInstance`'s `Endpoint.Address`) — keeps missing it for as long as the
 * resource's own properties do not change.
 *
 * The heal is LAZY: it runs only when a resolution is about to take the
 * resolver's physical-id fallback (a refusal for an `*Arn` / `*Url` name, a
 * warn-and-return otherwise), re-reads the resource through its provider's
 * read-only `import()` ONCE per deploy, serves the value from that read, and
 * hands the read-back map to the deploy engine, which merges it into the record
 * at the state-save choke point. Design: `docs/design/1852-stale-attribute-heal.md`.
 *
 * A LEAF on purpose — types only from `../types/**` — so both the resolver and
 * the deploy engine import it without touching the import ring they sit on.
 */
import type { ResourceState } from '../types/state.js';

/**
 * What one heal attempt observed. NEVER thrown: a heal must not fail a deploy
 * that would have passed, so every failure is a value the resolver renders.
 */
export type StaleAttributeHealOutcome =
  /** The read succeeded. `attributes` is normalized (no `undefined` / `null` / `''`). */
  | { readonly kind: 'read'; readonly attributes: Readonly<Record<string, unknown>> }
  /** The provider reports no resource behind the recorded physical id. */
  | { readonly kind: 'not-found' }
  /** The read threw (a denial, a throttle, a network failure, a mismatched answer). */
  | { readonly kind: 'failed'; readonly error: unknown }
  /**
   * No read was issued: the record was (re)written by THIS deploy, the type has
   * no read-only `import()`, or its attributes are not AWS-readable (a custom
   * resource's handler `Data`, a nested stack's child outputs).
   */
  | { readonly kind: 'not-attempted' };

/**
 * Supplied by a caller that can route a record to its provider. Single-flight
 * and memoized per deploy by the supplier; MUST NOT throw.
 */
export type StaleAttributeHealer = (
  logicalId: string,
  resource: ResourceState
) => Promise<StaleAttributeHealOutcome>;

/**
 * Per-resolution marker the resolver threads through a DERIVED context (never a
 * shared field — many resolutions run concurrently on one resolver instance).
 *
 * - `probe`: the physical-id fallback raises {@link StaleAttributeMissSignal}
 *   instead of deciding, so the caller can heal first.
 * - `settled`: the heal ran (or was declined); the fallback decides, and words
 *   its refusal from `outcome`.
 */
export type StaleAttributeHealPhase =
  | { readonly phase: 'probe' }
  | { readonly phase: 'settled'; readonly outcome: StaleAttributeHealOutcome };

/**
 * Control-flow signal from the physical-id fallback to `resolveGetAtt`'s heal
 * wrapper. It never escapes that wrapper: it is raised only under a `probe`
 * context, which only the wrapper builds, and the wrapper catches it on the
 * same `await`. An `Error` subclass so a lint rule or a stray `catch` that
 * assumes `Error` still behaves.
 */
export class StaleAttributeMissSignal extends Error {
  constructor() {
    super('stale attribute miss (internal control flow — must not escape resolveGetAtt)');
    this.name = 'StaleAttributeMissSignal';
    Object.setPrototypeOf(this, StaleAttributeMissSignal.prototype);
  }
}

const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * Types whose `attributes` are NOT an AWS read-back: a custom resource's are its
 * handler's response `Data` (possibly `NoEcho`, and re-invoking the handler is
 * not a read), a nested stack's are its child's outputs.
 */
export function isHealExcludedType(resourceType: string): boolean {
  return (
    resourceType === NESTED_STACK_RESOURCE_TYPE ||
    resourceType === 'AWS::CloudFormation::CustomResource' ||
    resourceType.startsWith('Custom::')
  );
}

/**
 * Drop every member that is not a value: `undefined`, `null` and `''`.
 *
 * Empty-to-absent is the point for the `--no-wait` `DBInstance` row
 * (go-to-k/cdkd#3077): an instance still `creating` has no endpoint, and an
 * empty value persisted into the record would be SERVED by the resolver's
 * cached read forever, shadowing every later heal.
 */
export function normalizeHealedAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (attributes === undefined || attributes === null || typeof attributes !== 'object') return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === '__proto__') continue; // `out[key] = ...` would set the prototype
    out[key] = value;
  }
  return out;
}

/**
 * Read `attributeName` out of a healed map the way `resolveGetAtt` reads the
 * recorded one: flat key first (SDK providers record `Endpoint.Port` flat), then
 * a dot-path walk (Cloud Control records nested objects). `Object.hasOwn` at
 * every step — `attributeName` is template text (issue #2767).
 */
export function readHealedAttribute(
  attributes: Readonly<Record<string, unknown>>,
  attributeName: string
): unknown {
  if (Object.hasOwn(attributes, attributeName)) {
    const flat = attributes[attributeName];
    if (flat !== undefined && flat !== null && flat !== '') return flat;
  }
  if (!attributeName.includes('.')) return undefined;
  let cursor: unknown = attributes;
  for (const part of attributeName.split('.')) {
    if (
      cursor !== null &&
      typeof cursor === 'object' &&
      Object.hasOwn(cursor as Record<string, unknown>, part)
    ) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor === null || cursor === '' ? undefined : cursor;
}

/**
 * Merge a healed map INTO a record's attributes: a healed key is added only
 * where the record holds NO value for it (or holds one `isStaleValue` declares
 * unusable — the pre-#1681 placeholder ARN). A recorded value always wins
 * otherwise: create-time attributes the read does not report must survive, and
 * a read must never rewrite what a provider recorded.
 *
 * Returns the SAME `recorded` reference when nothing was added, so a caller can
 * tell "healed" from "nothing to do" by identity.
 */
export function mergeHealedAttributes(
  recorded: Record<string, unknown> | undefined,
  healed: Readonly<Record<string, unknown>>,
  isStaleValue: (key: string, value: unknown) => boolean
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(healed)) {
    if (value === undefined || value === null || value === '') continue;
    // A provider-reported key, never template text — but `merged[key] = value`
    // with this one key would replace the bag's prototype instead of adding a member.
    if (key === '__proto__') continue;
    const has = recorded !== undefined && Object.hasOwn(recorded, key);
    if (has && !isStaleValue(key, recorded[key])) continue;
    merged ??= { ...recorded };
    merged[key] = value;
  }
  return merged ?? recorded;
}
