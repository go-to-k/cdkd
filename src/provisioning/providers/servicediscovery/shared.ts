import { isDeepStrictEqual } from 'node:util';
import { markNotGone } from '../../not-gone.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';

/**
 * Reset targets for a REMOVED `Properties.DnsProperties.SOA.TTL` (issue
 * #1160, servicediscovery batch). The Update*Namespace change objects MERGE
 * (an absent field keeps the live value), so the provider must send the
 * reset explicitly to mirror CloudFormation — and the default TTL is
 * PER KIND, not shared:
 *  - PublicDnsNamespace: 60. Live CFn A/B 2026-08-11 (removing the SOA
 *    block reset the customized 300 back to 60) + raw-SDK create-default
 *    probe (a namespace created without Properties reports TTL 60).
 *  - PrivateDnsNamespace: 15. Raw-SDK create-default probe 2026-08-11 (a
 *    namespace created without Properties reports TTL 15 — matching the
 *    PR #201-era live observation recorded on the create path below) +
 *    live CFn A/B 2026-08-11 on the private kind itself.
 * Removing `Description` clears it entirely on every kind (the `''`
 * sentinel; measured per kind, see `removalDefaults`).
 */
export const PUBLIC_DNS_NAMESPACE_DEFAULT_SOA_TTL = 60;
export const PRIVATE_DNS_NAMESPACE_DEFAULT_SOA_TTL = 15;

/**
 * `CreateService`'s retry on `NamespaceNotFound` right after the namespace was
 * created (issue #5113): 0.5s -> 1s -> 2s, then 4s flat, over 9 retries — 27.5s
 * of backoff, about 30s with the calls themselves.
 */
export const CREATE_SERVICE_NAMESPACE_LAG_MAX_RETRIES = 9;
export const CREATE_SERVICE_NAMESPACE_LAG_INITIAL_DELAY_MS = 500;
export const CREATE_SERVICE_NAMESPACE_LAG_MAX_DELAY_MS = 4_000;
/** The schedule's total backoff, for the give-up message (27.5). */
export const CREATE_SERVICE_NAMESPACE_LAG_BACKOFF_SECONDS =
  Array.from({ length: CREATE_SERVICE_NAMESPACE_LAG_MAX_RETRIES }, (_, i) =>
    Math.min(
      CREATE_SERVICE_NAMESPACE_LAG_INITIAL_DELAY_MS * 2 ** i,
      CREATE_SERVICE_NAMESPACE_LAG_MAX_DELAY_MS
    )
  ).reduce((a, b) => a + b, 0) / 1000;

/** The three namespace kinds, which share one Description removal reset. */
export const NAMESPACE_TYPES = [
  'AWS::ServiceDiscovery::PrivateDnsNamespace',
  'AWS::ServiceDiscovery::HttpNamespace',
  'AWS::ServiceDiscovery::PublicDnsNamespace',
] as const;

/** Each namespace kind's `Namespace.Type` (go-to-k/cdkd#4606). */
export const NAMESPACE_KIND_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['AWS::ServiceDiscovery::PrivateDnsNamespace', 'DNS_PRIVATE'],
  ['AWS::ServiceDiscovery::PublicDnsNamespace', 'DNS_PUBLIC'],
  ['AWS::ServiceDiscovery::HttpNamespace', 'HTTP'],
]);

/**
 * Whether a RESOLVED desired value is the one the state record holds, for
 * {@link ServiceDiscoveryProvider}'s Service change planning (issue #1160).
 * The record is REDACTED: a dynamic reference may stay its
 * `{{resolve:...}}` token (any kind, not only a secret one) and a `NoEcho`
 * value is `***`, while the desired
 * bag carries the plaintext. Such a recorded leaf cannot be compared, so it
 * counts as CHANGED: a wildcard would silently drop a real template change
 * (one secret reference swapped for another), and sending the declared value
 * again is harmless. Every other leaf is compared deep and strict.
 *
 * Only the FALLBACK when the deploy engine passes no
 * `UpdateContext.changedProperties` (go-to-k/cdkd#5112): a rollback revert,
 * `cdkd drift --revert`, or a direct call. A deploy's in-place update passes
 * the keys that changed template to template, as CloudFormation compares, so
 * an unchanged `Description` recorded as a dynamic reference with a
 * `HealthCheckConfig` removed beside it keeps the health check there. One
 * recorded as a `NoEcho` `***` is left out of those keys only when the engine
 * read the service back and AWS holds its value; otherwise it is named, and
 * sent.
 */
export function sameAsRecorded(desired: unknown, recorded: unknown): boolean {
  if (typeof recorded === 'string' && isRecordedStandIn(recorded)) return false;
  if (Array.isArray(desired) && Array.isArray(recorded)) {
    return (
      desired.length === recorded.length &&
      desired.every((item, i) => sameAsRecorded(item, recorded[i]))
    );
  }
  if (
    desired !== null &&
    recorded !== null &&
    typeof desired === 'object' &&
    typeof recorded === 'object' &&
    !Array.isArray(desired) &&
    !Array.isArray(recorded)
  ) {
    const d = desired as Record<string, unknown>;
    const r = recorded as Record<string, unknown>;
    const keys = new Set([...Object.keys(d), ...Object.keys(r)]);
    return [...keys].every(
      (key) => Object.hasOwn(d, key) === Object.hasOwn(r, key) && sameAsRecorded(d[key], r[key])
    );
  }
  return isDeepStrictEqual(desired, recorded);
}

/**
 * The `DnsConfig` members of a Cloud Map service that changed but cannot be
 * applied in place (go-to-k/cdkd#5373): `UpdateService`'s `DnsConfigChange`
 * carries `DnsRecords` only, so a `NamespaceId` or `RoutingPolicy` change has
 * no member to send. CloudFormation behaves the same way. Measured in
 * us-east-1 on 2026-10-26: moving `DnsConfig.NamespaceId` to another namespace
 * and changing `RoutingPolicy` from MULTIVALUE to WEIGHTED, each on its own and
 * beside a `Description` change, planned `Modify` with `Replacement: False`,
 * ended `UPDATE_COMPLETE` and left the service id, namespace and routing
 * policy as they were. cdkd matches that outcome and names the members in a
 * warning instead of staying silent.
 *
 * Only a `DnsConfig` the template still declares is compared: a removed
 * `DnsConfig` is the #1160 removal path in {@link planServiceChange}.
 */
export function unappliedDnsConfigMembers(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  changedProperties: ReadonlySet<string> | undefined
): string[] {
  if (changedProperties !== undefined && !changedProperties.has('DnsConfig')) return [];
  const desired = properties['DnsConfig'];
  const previous = previousProperties['DnsConfig'];
  if (!isPlainObject(desired) || !isPlainObject(previous)) return [];
  return ['NamespaceId', 'RoutingPolicy'].filter(
    (member) => !sameAsRecorded(desired[member], previous[member])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A recorded string standing in for a resolved secret: a dynamic reference, or the mask. */
function isRecordedStandIn(value: string): boolean {
  return dynamicReferenceTokens(value).length > 0 || value.includes(SECRET_MASK);
}

/** The id forms Cloud Map generates: `ns-` / `srv-` and 16 lowercase alphanumerics. */
export const NAMESPACE_ID_PATTERN = /^ns-[a-z0-9]{16}$/;
export const SERVICE_ID_PATTERN = /^srv-[a-z0-9]{16}$/;

/**
 * A DELETE failure wrap whose caught error's CLASS spells `NotFound`, marked
 * not gone (go-to-k/cdkd#2319, #5228). The wrap names the class, and the
 * deploy and destroy delete classifiers (`deploy-engine/delete.ts`,
 * `deploy-engine/update-in-place.ts`, `destroy-runner.ts`) read `NotFound`
 * in a message as "already deleted" unless the error is marked. This
 * resource's own not-found returned before the wrap, so a `NotFound` class
 * reaching it is another object's (an operation, a key, a namespace) and the
 * resource may still exist. Retryability stays the retry classifiers'.
 */
export function markNotGoneOnNotFoundClass<E extends Error>(error: unknown, wrapped: E): E {
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(wrapped) : wrapped;
}
