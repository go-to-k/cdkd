import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import {
  generateResourceNameWithFallback,
  getCurrentSkipPrefix,
  withSkipPrefix,
} from '../../provisioning/resource-name.js';
import { withDerivedNameMasks } from '../../provisioning/masked-retry-logger.js';
import {
  ownEntry,
  SENT_NAME_REWRITTEN,
  CASE_INSENSITIVE_NAME_TYPES,
  GENERATED_NAME_VERBATIM,
} from './name-keys.js';
import { valueAt, holderIdNames } from './holder-probe.js';
import { type ReplacementNameChange, replacementCreateAdoptsName } from './deploy-name.js';

/**
 * Which user-supplied-name prefix flag a rollback replays one op under
 * (go-to-k/cdkd#4024). See {@link replayPrefixChoice}.
 *
 * - `not-applicable`: the flag cannot change what is sent (not a
 *   `SENT_NAME_REWRITTEN` type, a Cloud Control route, or no explicit name —
 *   a logical-id name keeps the prefix under either flag).
 * - `reproduced`: `skipPrefix` derives a name the old physical id names.
 * - `unreproduced`: neither flag does, or it cannot be decided; `skipPrefix`
 *   is the current scope's (the failed deploy's) and `names` the two
 *   derivations when they could be computed.
 */
export type ReplayPrefixChoice =
  | { readonly kind: 'not-applicable' }
  | {
      readonly kind: 'reproduced';
      readonly skipPrefix: boolean;
      /** The current scope's flag, for the caller's note when it differs. */
      readonly recorded: boolean;
      readonly property: string;
      /** The declared (PLAINTEXT) name, so a caller can tell a secret-derived one. */
      readonly declared: string;
      readonly names: { readonly skipped: string; readonly kept: string };
    }
  | {
      readonly kind: 'unreproduced';
      readonly skipPrefix: boolean;
      readonly property: string;
      readonly declared: string | undefined;
      readonly names: { readonly skipped: string; readonly kept: string } | undefined;
    };

/**
 * The prefix flag a rollback should replay an op of a `SENT_NAME_REWRITTEN`
 * type under: the one whose derived name REPRODUCES the old resource's
 * physical id (go-to-k/cdkd#4024).
 *
 * The replay's scope carries the FAILED deploy's flag (#4018), but the old
 * resource was created by an EARLIER deploy, which may have run under the
 * other one. Its provider derives the name from the flag (for a re-create,
 * and for an in-place `update()` that re-derives the name and replaces on a
 * mismatch), so replaying under the failed deploy's flag restores the resource
 * under a name it never had. The physical id records the name it DID have:
 * the name itself for an IAM Role / User / Group / InstanceProfile, the last
 * `/` segment of a ManagedPolicy ARN (`arn:…:policy[/path]/<name>`), the name
 * segment of an ELBv2 ARN (`…:targetgroup/<name>/<id>`,
 * `…:loadbalancer/<app|net|gwy>/<name>/<id>`).
 *
 * Call it in the replay's own async scope (stack name, recorded flag): both
 * derivations run there with only the flag overridden. The current flag wins
 * when both derive a name the id names (no stack name in scope); neither, or
 * an old id / explicit name cdkd cannot read, keeps the current flag as
 * `unreproduced`, which the caller warns about. Names compare in the type's
 * case rule (`CASE_INSENSITIVE_NAME_TYPES`).
 */
export function replayPrefixChoice(input: {
  resourceType: string;
  /** The bag the replay sends (the old resource's resolved properties). */
  properties: Record<string, unknown> | undefined;
  logicalId: unknown;
  /** The old resource's physical id. */
  physicalId: unknown;
  /** The route the replay's create / update takes. */
  via: ProvisionedBy | undefined;
}): ReplayPrefixChoice {
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, input.resourceType);
  if (rewrite === undefined || input.via === 'cc-api') return { kind: 'not-applicable' };
  const raw = input.properties?.[rewrite.property];
  // What `generateResourceNameWithFallback` reads as "no explicit name": the
  // logical-id name is prefixed under either flag. A `null` is NOT that (the
  // generator passes it on), so it falls to the undecided arm below.
  if (raw === undefined || raw === '') return { kind: 'not-applicable' };
  const recorded = getCurrentSkipPrefix();
  const property = rewrite.property;
  const declared = valueAt(input.properties, [property]);
  if (
    declared === undefined ||
    typeof input.logicalId !== 'string' ||
    typeof input.physicalId !== 'string' ||
    input.physicalId === ''
  ) {
    return { kind: 'unreproduced', skipPrefix: recorded, property, declared, names: undefined };
  }
  const [skipped = '', kept = ''] = rewrittenNameSpellings(
    input.resourceType,
    declared,
    input.logicalId
  );
  const fold = CASE_INSENSITIVE_NAME_TYPES.has(input.resourceType)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  const id = fold(input.physicalId);
  const names = { skipped, kept };
  const reproduces = (skip: boolean): boolean => {
    const name = skip ? names.skipped : names.kept;
    return name !== '' && holderIdNames(id, fold(name));
  };
  const decided = { recorded, property, declared, names };
  if (reproduces(recorded)) return { kind: 'reproduced', skipPrefix: recorded, ...decided };
  if (reproduces(!recorded)) return { kind: 'reproduced', skipPrefix: !recorded, ...decided };
  return { kind: 'unreproduced', skipPrefix: recorded, property, declared, names };
}

/**
 * The names a `SENT_NAME_REWRITTEN` type's provider derives from `declared`
 * under EACH prefix setting, in the caller's async scope (stack name), for the
 * rollback executor's derived-name masks (go-to-k/cdkd#4037). Empty for any
 * other type, a nameless bag, or an id cdkd cannot derive from.
 */
export function rewrittenNameSpellings(
  resourceType: string,
  declared: string,
  logicalId: unknown
): string[] {
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, resourceType);
  if (rewrite === undefined || declared === '' || typeof logicalId !== 'string') return [];
  return [true, false].map((skip) =>
    withSkipPrefix(skip, () =>
      generateResourceNameWithFallback(declared, logicalId, { maxLength: rewrite.maxLength })
    )
  );
}

/**
 * The name a `SENT_NAME_REWRITTEN` provider sends for `properties`' explicit
 * name, derived in the CALLER's async scope (stack name, prefix flag), or
 * `undefined` for another type or without an explicit string name.
 */
function sentRewrittenName(
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  logicalId: string
): { property: string; declared: string; sent: string } | undefined {
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, resourceType);
  if (rewrite === undefined) return undefined;
  const declared = properties?.[rewrite.property];
  if (typeof declared !== 'string' || declared === '') return undefined;
  const sent = generateResourceNameWithFallback(declared, logicalId, {
    maxLength: rewrite.maxLength,
  });
  return { property: rewrite.property, declared, sent };
}

/** The name segment of an ELBv2 load balancer or target group ARN. */
const ELBV2_ARN_NAME =
  /^arn:[^:]+:elasticloadbalancing:[^:]*:[^:]*:(?:loadbalancer\/(?:app|net|gwy)\/|targetgroup\/)([^/]+)\/[^/]+$/;

/**
 * Does a name-adopting, name-REWRITING create send a name the old resource
 * does not hold although the template's name did not change
 * (go-to-k/cdkd#3937 review)? ELBv2 sends the template `Name` with the
 * stack-name prefix under `--prefix-user-supplied-names` only, so a
 * replacement under the other flag than the one that created the old
 * resource SENDS another name, and {@link replacementRequestsDifferentName}
 * — which compares template names — never asks the probe. The sent name is
 * compared, exactly, with the name the old physical id carries; anything
 * unreadable answers `undefined`, the pre-existing behaviour.
 */
export function replacementSentNameMoves(input: {
  oldResourceType: string;
  newResourceType: string;
  createdVia: ProvisionedBy | undefined;
  desiredProperties: Record<string, unknown> | undefined;
  physicalId: string;
  logicalId: string;
}): ReplacementNameChange | undefined {
  if (input.oldResourceType !== input.newResourceType) return undefined;
  if (!replacementCreateAdoptsName(input.newResourceType, input.createdVia)) return undefined;
  const sent = sentRewrittenName(input.newResourceType, input.desiredProperties, input.logicalId);
  if (sent === undefined || sent.declared.includes('{{resolve:')) return undefined;
  const held = ELBV2_ARN_NAME.exec(input.physicalId)?.[1];
  if (held === undefined || held === sent.sent) return undefined;
  return {
    property: sent.property,
    desiredName: sent.sent,
    heldName: held,
    heldProperty: sent.property,
    physicalId: input.physicalId,
  };
}

/**
 * `base`, extended to mask the spelling a `SENT_NAME_REWRITTEN` provider
 * sends for a SECRET-derived explicit name (go-to-k/cdkd#3937 review): the
 * rewrite (`_` / `.` to `-`, a prefix, a hash past the cap) is not the
 * plaintext the base masker matches, and a name probe's refusal prints the
 * holder's ARN, which carries that spelling, under either prefix flag. Any
 * other type, or a name that
 * is not secret-derived, returns `base` unchanged.
 */
export function maskRewrittenSentName(
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  logicalId: string,
  base: (text: string) => string
): (text: string) => string {
  const sent = sentRewrittenName(resourceType, properties, logicalId);
  if (sent === undefined) return base;
  // Both prefix flags' spellings: a probe of a sent name the flag moved
  // ({@link replacementSentNameMoves}) prints the OLD resource's name, the
  // other flag's spelling of the same value.
  const spellings = [sent.sent, ...rewrittenNameSpellings(resourceType, sent.declared, logicalId)];
  const quiet = { debug: (): void => undefined, warn: (): void => undefined };
  return withDerivedNameMasks(
    quiet,
    {
      mask: base,
      value: (value: unknown) => base(String(value)),
      debug: quiet.debug,
      warn: quiet.warn,
    },
    spellings.map((spelling) => [sent.declared, spelling] as const)
  ).mask;
}

/** The rewriting types and their generator options, for the fence. */
export function reverseReplacementRewrittenNameTypes(): Readonly<
  Record<string, { readonly property: string; readonly maxLength: number }>
> {
  return SENT_NAME_REWRITTEN;
}

/** The case-insensitive name spaces, for the test that pins the list. */
export function reverseReplacementCaseInsensitiveTypes(): readonly string[] {
  return [...CASE_INSENSITIVE_NAME_TYPES].sort();
}

/** The audited verbatim-generation types, for the test that pins the list. */
export function reverseReplacementVerbatimGeneratedTypes(): readonly string[] {
  return [...GENERATED_NAME_VERBATIM].sort();
}

/** Does cdkd's generation rule name what this type's nameless create sends? */
export function reverseReplacementTrustsGeneratedName(resourceType: string): boolean {
  return GENERATED_NAME_VERBATIM.has(resourceType);
}
