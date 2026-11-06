import {
  GetServiceAttributesCommand,
  GetNamespaceCommand,
  GetServiceCommand,
  ListTagsForResourceCommand,
  NamespaceNotFound,
  ServiceNotFound,
} from '@aws-sdk/client-servicediscovery';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  type ResourceNotFound,
  type ResourceIdentityVerdict,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import type { ServiceDiscoveryProvider } from '../servicediscovery-provider.js';
import { NAMESPACE_KIND_BY_TYPE, NAMESPACE_ID_PATTERN, SERVICE_ID_PATTERN } from './shared.js';

// ─── Attribute resolution ─────────────────────────────────────────

/**
 * Resolve a `Fn::GetAtt` attribute live from AWS (used by `cdkd orphan`'s
 * sibling-reference rewriting and other post-deploy attribute reads).
 *
 * Namespace kinds resolve `Id` / `Arn` (plus `HostedZoneId` for the DNS
 * namespace kinds, read from `GetNamespace`'s
 * `Properties.DnsProperties.HostedZoneId`); Services resolve `Id` / `Arn` /
 * `Name` via `GetService`. Returns `undefined` for unknown attributes and
 * for gone resources.
 */
export async function getAttribute(
  this: ServiceDiscoveryProvider,
  physicalId: string,
  resourceType: string,
  attributeName: string
): Promise<unknown> {
  switch (resourceType) {
    case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
    case 'AWS::ServiceDiscovery::HttpNamespace':
    case 'AWS::ServiceDiscovery::PublicDnsNamespace': {
      if (attributeName === 'Id') return physicalId;
      if (attributeName !== 'Arn' && attributeName !== 'HostedZoneId') return undefined;
      try {
        const resp = await this.getClient().send(new GetNamespaceCommand({ Id: physicalId }));
        if (attributeName === 'Arn') return resp.Namespace?.Arn;
        return resp.Namespace?.Properties?.DnsProperties?.HostedZoneId;
      } catch (err) {
        if (err instanceof NamespaceNotFound) return undefined;
        throw err;
      }
    }
    case 'AWS::ServiceDiscovery::Service': {
      if (attributeName === 'Id') return physicalId;
      if (attributeName !== 'Arn' && attributeName !== 'Name') return undefined;
      try {
        const resp = await this.getClient().send(new GetServiceCommand({ Id: physicalId }));
        return attributeName === 'Arn' ? resp.Service?.Arn : resp.Service?.Name;
      } catch (err) {
        if (err instanceof ServiceNotFound) return undefined;
        throw err;
      }
    }
    default:
      return undefined;
  }
}

// ─── Identity (go-to-k/cdkd#4606) ─────────────────────────────────

/**
 * go-to-k/cdkd#4606: whether the namespace or service a failed CREATE
 * journaled (a namespace whose create operation succeeded before a later
 * step failed; a service whose `ServiceAttributes` wiring failed and whose
 * cleanup delete failed too) is the one the record under the same logical
 * id holds (a fix-forward that created a new one there).
 *
 * The identity is the id Cloud Map generates: a namespace's `ns-…` and a
 * service's `srv-…` id, the physical id the create and the import record,
 * unique per account and region and never reassigned, so two distinct ids in
 * the stack's region name two distinct resources. Any other form is
 * `'unknown'`. Equal ids are `'same'` without a read. After the region
 * check, the record's resource must read back under its own id (a
 * namespace also of the record's kind: `DNS_PRIVATE`, `DNS_PUBLIC` or
 * `HTTP`), else `'unknown'`; the journaled one is then `'different'`
 * whether it reads back under its own id or Cloud Map reports it gone (a
 * read answering the record's id or a third one is `'unknown'`). Any other read failure throws,
 * which the caller reads as `'unknown'`.
 *
 * SDK-routed resources only: the settle asks the provider the journaled
 * operation was provisioned by, so a Cloud Control-routed namespace or
 * service never reaches this method and keeps the warning.
 */
export async function isSameResource(
  this: ServiceDiscoveryProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  let pattern: RegExp;
  let read: (id: string) => Promise<string | undefined>;
  const namespaceKind = NAMESPACE_KIND_BY_TYPE.get(resourceType);
  if (namespaceKind !== undefined) {
    pattern = NAMESPACE_ID_PATTERN;
    read = (id) => this.readNamespaceIdForIdentity(id, namespaceKind);
  } else if (resourceType === 'AWS::ServiceDiscovery::Service') {
    pattern = SERVICE_ID_PATTERN;
    read = (id) => this.readServiceIdForIdentity(id);
  } else {
    return 'unknown';
  }
  if (!pattern.test(journaledPhysicalId) || !pattern.test(record.physicalId)) return 'unknown';
  if (journaledPhysicalId === record.physicalId) return 'same';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  if ((await read(record.physicalId)) !== record.physicalId) return 'unknown';
  const journaledRead = await read(journaledPhysicalId);
  // Gone, or read back under its own id. Any other answer (the record's id,
  // or a third one) is a state Cloud Map should not produce: 'unknown', so
  // the settle keeps the entry and warns rather than dropping it as tracked.
  return journaledRead === undefined || journaledRead === journaledPhysicalId
    ? 'different'
    : 'unknown';
}

/**
 * The id `GetNamespace` reports for `namespaceId` when the namespace is of
 * `kind`; `undefined` when Cloud Map reports it gone (`NamespaceNotFound`).
 * A response naming no namespace, or one of another kind, throws: "could
 * not read" never reads as "gone".
 */
export async function readNamespaceIdForIdentity(
  this: ServiceDiscoveryProvider,
  namespaceId: string,
  kind: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.getClient().send(new GetNamespaceCommand({ Id: namespaceId }));
  } catch (error) {
    if (error instanceof NamespaceNotFound) return undefined;
    throw error;
  }
  const namespace = response.Namespace;
  if (typeof namespace?.Id !== 'string' || namespace.Type !== kind) {
    throw new Error('GetNamespace did not return a namespace of the kind asked for');
  }
  return namespace.Id;
}

/**
 * The id `GetService` reports for `serviceId`; `undefined` when Cloud Map
 * reports it gone (`ServiceNotFound`). A response naming no service throws.
 */
export async function readServiceIdForIdentity(
  this: ServiceDiscoveryProvider,
  serviceId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.getClient().send(new GetServiceCommand({ Id: serviceId }));
  } catch (error) {
    if (error instanceof ServiceNotFound) return undefined;
    throw error;
  }
  if (typeof response.Service?.Id !== 'string') {
    throw new Error('GetService did not return the service asked for');
  }
  return response.Service.Id;
}

// ─── Import dispatch ──────────────────────────────────────────────

/**
 * Adopt an existing Cloud Map (Service Discovery) resource into cdkd state.
 *
 *  - **AWS::ServiceDiscovery::PrivateDnsNamespace**: tag-based auto-lookup
 *    via `ListNamespaces` + `ListTagsForResource(ResourceARN)` (Tag[]
 *    array). Falls back to `--resource` override or matching
 *    `Properties.Name` against the namespace name.
 *  - **AWS::ServiceDiscovery::Service**: same shape — `ListServices` +
 *    `ListTagsForResource`. Both use `Tag[]` arrays.
 */
/**
 * Read the AWS-current ServiceDiscovery resource configuration in CFn-property shape.
 *
 * Dispatch per resource type:
 *  - `PrivateDnsNamespace` → `GetNamespace` (Name, Description). `Vpc`
 *    is NOT returned by `GetNamespace` — Cloud Map exposes the VPC only
 *    at create time and via `ListNamespaces`-side `Properties.DnsProperties.HostedZoneId`,
 *    not as a directly comparable VPC ID. We skip it; the comparator
 *    only descends into keys present in cdkd state, so an absent key
 *    cannot fire false drift, but a `Vpc` change will not be detected
 *    via this provider's drift surface (use the CFn-side `aws cloudmap`
 *    CLI for that edge case).
 *  - `Service` → `GetService` (Name, NamespaceId, Description, Type,
 *    DnsConfig, HealthCheckConfig, HealthCheckCustomConfig).
 *
 * Tags are surfaced via a follow-up `ListTagsForResource(ResourceARN)`
 * call (using the resource ARN from `GetNamespace.Arn` or
 * `GetService.Arn`). CDK's `aws:*` auto-tags are filtered out and the
 * result key is omitted when AWS reports no user tags. Returns
 * `RESOURCE_NOT_FOUND` when the resource is gone (`NamespaceNotFound` /
 * `ServiceNotFound`), `undefined` for another type.
 */
export async function readCurrentState(
  this: ServiceDiscoveryProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
    case 'AWS::ServiceDiscovery::PublicDnsNamespace':
      return this.readNamespace(physicalId, { includeProperties: true });
    case 'AWS::ServiceDiscovery::HttpNamespace':
      // HttpNamespace has no CFn `Properties` bag (no hosted zone / SOA).
      return this.readNamespace(physicalId, { includeProperties: false });
    case 'AWS::ServiceDiscovery::Service':
      return this.readService(physicalId);
    default:
      return undefined;
  }
}

/**
 * Declare drift-unreadable property paths.
 *
 * - `AWS::ServiceDiscovery::PrivateDnsNamespace.Vpc`: Cloud Map's
 *   `GetNamespace` does NOT return the VPC ID — it is only consumed at
 *   create time and surfaced in opaque form via
 *   `Properties.DnsProperties.HostedZoneId`. Without this declaration
 *   the comparator would walk into `Vpc` (state has it because cdkd
 *   stored the user-supplied template value) and report a guaranteed
 *   false-positive on every clean drift run, since `readCurrentState`
 *   deliberately omits the key.
 */
export function getDriftUnknownPaths(
  this: ServiceDiscoveryProvider,
  resourceType: string
): string[] {
  if (resourceType === 'AWS::ServiceDiscovery::PrivateDnsNamespace') {
    return ['Vpc'];
  }
  return [];
}

export async function readNamespace(
  this: ServiceDiscoveryProvider,
  physicalId: string,
  options: { includeProperties: boolean }
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let ns;
  try {
    const resp = await this.getClient().send(new GetNamespaceCommand({ Id: physicalId }));
    ns = resp.Namespace;
  } catch (err) {
    if (err instanceof NamespaceNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!ns) return undefined;

  const result: Record<string, unknown> = {};
  if (ns.Name !== undefined) result['Name'] = ns.Name;
  result['Description'] = ns.Description ?? '';
  if (options.includeProperties) {
    // Properties.DnsProperties.SOA.TTL is the only mutable nested field
    // (PR #195's update path round-trips it). Surface it on read too so
    // the comparator can detect a console-side TTL change. Always emit
    // the Properties placeholder for v3 baseline parity. HttpNamespace
    // skips this — it has no CFn `Properties` bag.
    const soa = ns.Properties?.DnsProperties?.SOA;
    if (soa?.TTL !== undefined) {
      result['Properties'] = { DnsProperties: { SOA: { TTL: soa.TTL } } };
    } else {
      result['Properties'] = {};
    }
  }
  if (ns.Arn) await this.attachTags(result, ns.Arn);
  return result;
}

export async function readService(
  this: ServiceDiscoveryProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let svc;
  try {
    const resp = await this.getClient().send(new GetServiceCommand({ Id: physicalId }));
    svc = resp.Service;
  } catch (err) {
    if (err instanceof ServiceNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!svc) return undefined;

  const result: Record<string, unknown> = {};
  if (svc.Name !== undefined) result['Name'] = svc.Name;
  if (svc.NamespaceId !== undefined) result['NamespaceId'] = svc.NamespaceId;
  result['Description'] = svc.Description ?? '';
  if (svc.Type !== undefined) result['Type'] = svc.Type;
  if (svc.DnsConfig) {
    result['DnsConfig'] = svc.DnsConfig as unknown as Record<string, unknown>;
  }
  if (svc.HealthCheckConfig) {
    result['HealthCheckConfig'] = svc.HealthCheckConfig as unknown as Record<string, unknown>;
  }
  if (svc.HealthCheckCustomConfig) {
    result['HealthCheckCustomConfig'] = svc.HealthCheckCustomConfig as unknown as Record<
      string,
      unknown
    >;
  }

  // ServiceAttributes via GetServiceAttributes (a separate call from
  // GetService). Emit the full key→value map so a console-side attribute
  // change surfaces as drift against the deploy-time baseline. On a
  // permission / transient error leave the key absent rather than firing
  // false drift on every run (matching attachTags' best-effort posture);
  // the drift comparator is state-keys-only so an absent key is safe.
  try {
    const attrsResp = await this.getClient().send(
      new GetServiceAttributesCommand({ ServiceId: physicalId })
    );
    result['ServiceAttributes'] = attrsResp.ServiceAttributes?.Attributes ?? {};
  } catch (err) {
    this.logger.debug(
      `ServiceDiscovery GetServiceAttributes(${physicalId}) failed: ${describeAwsFailure(err).detail}`
    );
  }

  if (svc.Arn) await this.attachTags(result, svc.Arn);
  return result;
}

/**
 * Normalize a CFn `ServiceAttributes` value (a bare key→value JSON map) into
 * the SDK's `Attributes` shape (`Record<string,string>`). Only string /
 * number / boolean values are coerced via `String()`; a non-scalar value is
 * malformed input and is dropped rather than stringified to `[object
 * Object]`. A non-object input (absent / null / array) yields `{}` so callers
 * can branch on `Object.keys(...).length`.
 */
export function normalizeServiceAttributes(
  this: ServiceDiscoveryProvider,
  raw: unknown
): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    }
  }
  return out;
}

/** Best-effort tag fetch via `ListTagsForResource(ResourceARN)`. */
export async function attachTags(
  this: ServiceDiscoveryProvider,
  result: Record<string, unknown>,
  arn: string
): Promise<void> {
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForResourceCommand({ ResourceARN: arn })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
    result['Tags'] = tags;
  } catch (err) {
    this.logger.debug(
      `ServiceDiscovery ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
    );
  }
}
