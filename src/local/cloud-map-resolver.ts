import type { StackInfo } from '../synthesis/assembly-reader.js';
import { EcsTaskResolutionError } from './ecs-task-resolver.js';

/**
 * Phase 3 of #262 (Issue #460) — `AWS::ServiceDiscovery::*` template
 * resolver. Walks the synthesized template once and produces a
 * stack-scoped index the service runner consults at boot to know:
 *
 *   - Which `PrivateDnsNamespace` logical ids are valid registration
 *     targets, and what their `Name` (= the namespace string used in
 *     `<discoveryName>.<namespace>` DNS lookups) is.
 *   - Which `AWS::ServiceDiscovery::Service` entries the user
 *     templated, what namespace they belong to, and what discovery
 *     name they register under. (`cdkd local start-service` then
 *     registers each replica of the ECS Service that has this as a
 *     `ServiceRegistry` target into the matching namespace + discovery
 *     name.)
 *
 * **Non-private namespaces hard-reject** at the resolver layer per the
 * design doc's §2 "Non-goals" table — `PublicDnsNamespace` and
 * `HttpNamespace` are out of scope for local emulation. The resolver
 * doesn't actually surface those types (they're filtered upstream), but
 * each ECS Service's `ServiceConnectConfiguration.Namespace` value (a
 * literal string `Name`, NOT a Ref / ARN, per CDK 2.x synth shape
 * verified 2026-05-22) is matched against the resolved
 * `PrivateDnsNamespace` set; an unmatched namespace surfaces as an
 * explicit error rather than silently routing to nothing.
 */
export interface ResolvedCloudMapNamespace {
  /** AWS::ServiceDiscovery::PrivateDnsNamespace logical id. */
  logicalId: string;
  /** Namespace name as it would be looked up in DNS, e.g. `cdkd-local.local`. */
  name: string;
}

export interface ResolvedCloudMapService {
  /** AWS::ServiceDiscovery::Service logical id. */
  logicalId: string;
  /** Logical id of the parent namespace. */
  namespaceLogicalId: string;
  /** Resolved namespace name (denormalized for convenience). */
  namespaceName: string;
  /** Service name, e.g. `orders`. */
  name: string;
  /**
   * DNS record types declared by the user. cdkd v1 emits the same
   * `--add-host` mapping regardless of A vs SRV — both round-trip to
   * a single IP per consumer in the docker overlay (SRV record port
   * routing requires the DNS-sidecar option deferred from §6). The
   * field is parsed and surfaced so a future SRV-aware DNS sidecar
   * can consume it without re-parsing the template.
   */
  dnsRecords: ReadonlyArray<{ type: 'A' | 'SRV'; ttlSeconds: number }>;
}

/**
 * Pure-functional walk of one stack's template. Returns the resolved
 * namespace + service index for that stack. Cross-stack references
 * (Cloud Map Service in stack A referencing a namespace in stack B
 * via `Fn::ImportValue`) are NOT supported in v1 and surface as a
 * resolver error.
 */
export interface CloudMapIndex {
  /** All resolved private DNS namespaces, keyed by logical id. */
  namespacesByLogicalId: Map<string, ResolvedCloudMapNamespace>;
  /** Secondary index by namespace name (for `ServiceConnectConfiguration.Namespace` literal lookups). */
  namespacesByName: Map<string, ResolvedCloudMapNamespace>;
  /** All resolved cloud-map services, keyed by logical id. */
  servicesByLogicalId: Map<string, ResolvedCloudMapService>;
  /**
   * Non-fatal warnings (e.g. an unsupported namespace type, a service
   * that references a namespace not in this stack). Surfaced at boot
   * so users learn what's not being emulated.
   */
  warnings: string[];
}

/**
 * Build the `CloudMapIndex` for one stack's template. Empty index when
 * the stack declares no `AWS::ServiceDiscovery::*` resources.
 *
 * Hard-reject errors (throw `EcsTaskResolutionError`):
 *   - `AWS::ServiceDiscovery::PublicDnsNamespace` — defeats "local" semantics.
 *   - `AWS::ServiceDiscovery::HttpNamespace` — DiscoverInstances-only,
 *     no DNS, would require shimming the AWS SDK inside every container.
 *   - An `AWS::ServiceDiscovery::Service` with a `NamespaceId` that
 *     doesn't resolve to a same-stack `PrivateDnsNamespace`.
 */
export function buildCloudMapIndex(stack: StackInfo): CloudMapIndex {
  const namespacesByLogicalId = new Map<string, ResolvedCloudMapNamespace>();
  const namespacesByName = new Map<string, ResolvedCloudMapNamespace>();
  const servicesByLogicalId = new Map<string, ResolvedCloudMapService>();
  const warnings: string[] = [];
  const resources = stack.template.Resources ?? {};

  // PASS 1: namespaces first so service lookups have something to match.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::ServiceDiscovery::PublicDnsNamespace') {
      throw new EcsTaskResolutionError(
        `Stack ${stack.stackName}: AWS::ServiceDiscovery::PublicDnsNamespace '${logicalId}' ` +
          'is not supported by local emulation — public DNS defeats the "local" point. ' +
          'Use a PrivateDnsNamespace for cdkd local start-service.'
      );
    }
    if (resource.Type === 'AWS::ServiceDiscovery::HttpNamespace') {
      throw new EcsTaskResolutionError(
        `Stack ${stack.stackName}: AWS::ServiceDiscovery::HttpNamespace '${logicalId}' is not ` +
          'supported by local emulation — HttpNamespace uses the AWS Cloud Map ' +
          'DiscoverInstances API directly (no DNS), which would require shimming the AWS SDK ' +
          'inside every container. Use a PrivateDnsNamespace + DnsConfig instead.'
      );
    }
    if (resource.Type !== 'AWS::ServiceDiscovery::PrivateDnsNamespace') continue;

    const props = (resource.Properties ?? {}) as Record<string, unknown>;
    const name = typeof props['Name'] === 'string' ? props['Name'] : undefined;
    if (!name) {
      throw new EcsTaskResolutionError(
        `Stack ${stack.stackName}: PrivateDnsNamespace '${logicalId}' has no literal Name ` +
          'property. Intrinsic-valued names are not supported (cross-stack / dynamic ' +
          'namespace names require deploy-state resolution which is out of scope for v1).'
      );
    }
    const entry: ResolvedCloudMapNamespace = { logicalId, name };
    namespacesByLogicalId.set(logicalId, entry);
    if (namespacesByName.has(name)) {
      // Two namespaces with the same name in the same stack. CDK's
      // own `cluster.addDefaultCloudMapNamespace(...)` AND an
      // explicit `new cloudmap.PrivateDnsNamespace(...)` can collide
      // on the same name (verified via real synth). Keep the first;
      // surface a warn so users notice.
      warnings.push(
        `Stack ${stack.stackName}: two PrivateDnsNamespace resources share Name='${name}' ` +
          `('${namespacesByName.get(name)!.logicalId}' and '${logicalId}'). ` +
          'Local emulation routes registrations to the first; the second will silently shadow.'
      );
    } else {
      namespacesByName.set(name, entry);
    }
  }

  // PASS 2: services — needs the namespace index to resolve NamespaceId.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ServiceDiscovery::Service') continue;
    const props = (resource.Properties ?? {}) as Record<string, unknown>;

    const namespaceLogicalId = resolveNamespaceIdRef(
      props['NamespaceId'] ??
        (props['DnsConfig'] as Record<string, unknown> | undefined)?.['NamespaceId'],
      stack.stackName,
      logicalId
    );

    const ns = namespacesByLogicalId.get(namespaceLogicalId);
    if (!ns) {
      throw new EcsTaskResolutionError(
        `Stack ${stack.stackName}: AWS::ServiceDiscovery::Service '${logicalId}' references ` +
          `NamespaceId '${namespaceLogicalId}' but no PrivateDnsNamespace with that logical id ` +
          'exists in this stack. Cross-stack Cloud Map namespaces are not supported in v1.'
      );
    }

    const name = typeof props['Name'] === 'string' ? props['Name'] : undefined;
    if (!name) {
      throw new EcsTaskResolutionError(
        `Stack ${stack.stackName}: AWS::ServiceDiscovery::Service '${logicalId}' has no literal ` +
          'Name property. Intrinsic-valued names are not supported in v1.'
      );
    }

    const dnsRecords = extractDnsRecords(props);

    servicesByLogicalId.set(logicalId, {
      logicalId,
      namespaceLogicalId,
      namespaceName: ns.name,
      name,
      dnsRecords,
    });
  }

  return { namespacesByLogicalId, namespacesByName, servicesByLogicalId, warnings };
}

/**
 * Resolve `NamespaceId` to the parent's logical id. CDK 2.x synthesizes
 * this as `{Fn::GetAtt: ['<NsLogicalId>', 'Id']}` (verified via real
 * `cdk synth` on 2026-05-22). `Ref` is also accepted defensively
 * (returns the namespace's physical id, but inside one synth template
 * the Ref target IS the logical id we want).
 *
 * Cross-stack / intrinsic shapes that we cannot resolve at synth time
 * are hard-rejected — cdkd would otherwise silently route to no
 * namespace and the consumer would get an unhelpful "DNS lookup failed"
 * at runtime.
 */
function resolveNamespaceIdRef(raw: unknown, stackName: string, serviceLogicalId: string): string {
  if (typeof raw === 'string') {
    // Defensive: literal string id. Caller will match against the
    // namespace index and the literal is unlikely to match unless the
    // user pre-resolved it manually — but accept rather than reject.
    return raw;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj['Ref'] === 'string') return obj['Ref'];
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
      // `Fn::GetAtt: ['<NsLogicalId>', 'Id']` is the CDK-canonical shape.
      // We surface the logical id regardless of which attribute was
      // requested — the namespace index keys on logical id.
      return getAtt[0];
    }
  }
  throw new EcsTaskResolutionError(
    `Stack ${stackName}: AWS::ServiceDiscovery::Service '${serviceLogicalId}' has an ` +
      `unsupported NamespaceId reference shape: ${JSON.stringify(raw)}. Accepted shapes are ` +
      "{Fn::GetAtt: [<NsLogicalId>, 'Id']} or {Ref: <NsLogicalId>} pointing at a same-stack " +
      'PrivateDnsNamespace.'
  );
}

function extractDnsRecords(
  serviceProps: Record<string, unknown>
): ReadonlyArray<{ type: 'A' | 'SRV'; ttlSeconds: number }> {
  const dnsConfig = serviceProps['DnsConfig'];
  if (!dnsConfig || typeof dnsConfig !== 'object') return [];
  const records = (dnsConfig as Record<string, unknown>)['DnsRecords'];
  if (!Array.isArray(records)) return [];
  const out: { type: 'A' | 'SRV'; ttlSeconds: number }[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    const type = obj['Type'];
    if (type !== 'A' && type !== 'SRV') continue; // AAAA / CNAME skipped per §6.
    const ttl = obj['TTL'];
    const ttlSeconds =
      typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0
        ? Math.floor(ttl)
        : typeof ttl === 'string' && /^\d+$/.test(ttl)
          ? parseInt(ttl, 10)
          : 60;
    out.push({ type, ttlSeconds });
  }
  return out;
}
