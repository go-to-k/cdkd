import type { ELBv2Provider } from '../elbv2-provider.js';
import {
  DescribeLoadBalancersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetGroupAttributesCommand,
  DescribeTargetHealthCommand,
  DescribeCapacityReservationCommand,
  DescribeTagsCommand,
  DescribeListenersCommand,
  DescribeListenerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  type CfnTargetDescription,
  ATTRIBUTE_BAG_BY_TYPE,
  attributeEntryKey,
  isElbv2NotFoundName,
} from './shared.js';

/**
 * Read the AWS-current ELBv2 resource configuration in CFn-property shape.
 *
 * Dispatch per resource type:
 *  - `LoadBalancer` → `DescribeLoadBalancers` (Name, Subnets via
 *    `AvailabilityZones[].SubnetId`, SecurityGroups, Scheme, Type,
 *    IpAddressType) plus `DescribeLoadBalancerAttributes` for the full
 *    `LoadBalancerAttributes` `[{Key, Value}]` array (sorted by Key for
 *    stable positional compare). AWS returns every attribute valid for
 *    this LB type including defaults the user did not template; on the
 *    v3 observedProperties baseline that's load-bearing — a console-side
 *    change to ANY attribute (templated or not) surfaces as drift.
 *  - `TargetGroup` → `DescribeTargetGroups` (Protocol, Port, VpcId,
 *    TargetType, ProtocolVersion, HealthCheck*, Matcher, Name).
 *  - `Listener` → `DescribeListeners` (LoadBalancerArn, Certificates,
 *    DefaultActions, Port, Protocol, SslPolicy).
 *
 * Tags are surfaced via a follow-up `DescribeTags(ResourceArns=[arn])`
 * for all three types (the `physicalId` cdkd state holds is the ARN).
 * CDK's `aws:*` auto-tags are filtered out and the result key is omitted
 * when AWS reports no user tags. Returns `RESOURCE_NOT_FOUND` when the
 * resource is gone (`*NotFoundException`), `undefined` for another type.
 */
export async function readCurrentState(
  this: ELBv2Provider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return this.readLoadBalancer(physicalId);
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      return this.readTargetGroup(physicalId);
    case 'AWS::ElasticLoadBalancingV2::Listener':
      return this.readListener(physicalId);
    default:
      return undefined;
  }
}

export async function readLoadBalancer(
  this: ELBv2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let lb;
  try {
    const resp = await this.getClient().send(
      new DescribeLoadBalancersCommand({ LoadBalancerArns: [physicalId] })
    );
    lb = resp.LoadBalancers?.[0];
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    throw err;
  }
  if (!lb) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (lb.LoadBalancerName !== undefined) result['Name'] = lb.LoadBalancerName;
  const subnets = (lb.AvailabilityZones ?? [])
    .map((az) => az.SubnetId)
    .filter((id): id is string => !!id);
  result['Subnets'] = subnets;
  result['SecurityGroups'] = lb.SecurityGroups ? [...lb.SecurityGroups] : [];
  if (lb.Scheme !== undefined) result['Scheme'] = lb.Scheme;
  if (lb.Type !== undefined) result['Type'] = lb.Type;
  if (lb.IpAddressType !== undefined) result['IpAddressType'] = lb.IpAddressType;
  if (lb.EnablePrefixForIpv6SourceNat !== undefined) {
    result['EnablePrefixForIpv6SourceNat'] = lb.EnablePrefixForIpv6SourceNat;
  }
  if (lb.EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic !== undefined) {
    result['EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'] =
      lb.EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic;
  }
  // Flatten the SDK's IpamPools wrapper back to the CFn spelling.
  if (lb.IpamPools?.Ipv4IpamPoolId !== undefined) {
    result['Ipv4IpamPoolId'] = lb.IpamPools.Ipv4IpamPoolId;
  }

  // MinimumLoadBalancerCapacity via DescribeCapacityReservation —
  // best-effort like the attribute reads below; emitted only when a
  // reservation is actually set (CapacityUnits > 0) so LBs without one
  // don't grow a phantom key.
  try {
    const capResp = await this.getClient().send(
      new DescribeCapacityReservationCommand({ LoadBalancerArn: physicalId })
    );
    const units = capResp.MinimumLoadBalancerCapacity?.CapacityUnits;
    if (units !== undefined && units > 0) {
      result['MinimumLoadBalancerCapacity'] = { CapacityUnits: units };
    }
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    // Permission errors etc — leave key absent rather than firing
    // false drift on every run.
  }

  // LoadBalancerAttributes via DescribeLoadBalancerAttributes. AWS
  // returns the FULL attribute set (every key valid for this LB type,
  // including AWS-defaulted values the user did not template). We sort
  // by Key for stable positional compare and emit the whole list, so a
  // console-side change to any attribute (templated or not) surfaces
  // as drift on the v3 observedProperties baseline (which captures
  // the same full set at deploy time); an undeclared key AWS stops
  // returning is not drift (`canonicalizeDriftPair`). On the v2 fallback baseline
  // (state.properties) users templating only a subset will see drift
  // on the AWS-defaulted keys — that's the v2 limitation in general
  // and the documented motivation for upgrading to v3 / running
  // `cdkd state refresh-observed`.
  try {
    const attrsResp = await this.getClient().send(
      new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: physicalId })
    );
    const attrs = (attrsResp.Attributes ?? [])
      .filter(
        (a): a is { Key: string; Value: string } =>
          typeof a.Key === 'string' && typeof a.Value === 'string'
      )
      .map((a) => ({ Key: a.Key, Value: a.Value }))
      .sort((a, b) => a.Key.localeCompare(b.Key));
    result['LoadBalancerAttributes'] = attrs;
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    // Permission errors etc — leave key absent rather than firing
    // false drift on every run.
  }

  await this.attachTags(result, physicalId);
  return result;
}

export async function readTargetGroup(
  this: ELBv2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let tg;
  try {
    const resp = await this.getClient().send(
      new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
    );
    tg = resp.TargetGroups?.[0];
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    throw err;
  }
  if (!tg) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (tg.TargetGroupName !== undefined) result['Name'] = tg.TargetGroupName;
  if (tg.Protocol !== undefined) result['Protocol'] = tg.Protocol;
  if (tg.Port !== undefined) result['Port'] = tg.Port;
  if (tg.VpcId !== undefined) result['VpcId'] = tg.VpcId;
  if (tg.TargetType !== undefined) result['TargetType'] = tg.TargetType;
  if (tg.ProtocolVersion !== undefined) result['ProtocolVersion'] = tg.ProtocolVersion;
  if (tg.HealthCheckProtocol !== undefined) result['HealthCheckProtocol'] = tg.HealthCheckProtocol;
  if (tg.HealthCheckPort !== undefined) result['HealthCheckPort'] = tg.HealthCheckPort;
  if (tg.HealthCheckPath !== undefined) result['HealthCheckPath'] = tg.HealthCheckPath;
  if (tg.HealthCheckEnabled !== undefined) result['HealthCheckEnabled'] = tg.HealthCheckEnabled;
  if (tg.HealthCheckIntervalSeconds !== undefined) {
    result['HealthCheckIntervalSeconds'] = tg.HealthCheckIntervalSeconds;
  }
  if (tg.HealthCheckTimeoutSeconds !== undefined) {
    result['HealthCheckTimeoutSeconds'] = tg.HealthCheckTimeoutSeconds;
  }
  if (tg.HealthyThresholdCount !== undefined) {
    result['HealthyThresholdCount'] = tg.HealthyThresholdCount;
  }
  if (tg.UnhealthyThresholdCount !== undefined) {
    result['UnhealthyThresholdCount'] = tg.UnhealthyThresholdCount;
  }
  if (tg.IpAddressType !== undefined) result['IpAddressType'] = tg.IpAddressType;
  if (tg.TargetControlPort !== undefined) result['TargetControlPort'] = tg.TargetControlPort;
  const matcher: Record<string, unknown> = {};
  if (tg.Matcher?.HttpCode !== undefined) matcher['HttpCode'] = tg.Matcher.HttpCode;
  if (tg.Matcher?.GrpcCode !== undefined) matcher['GrpcCode'] = tg.Matcher.GrpcCode;
  result['Matcher'] = matcher;

  // TargetGroupAttributes via DescribeTargetGroupAttributes — the FULL
  // attribute set sorted by Key, same model as LoadBalancerAttributes /
  // ListenerAttributes.
  try {
    const attrsResp = await this.getClient().send(
      new DescribeTargetGroupAttributesCommand({ TargetGroupArn: physicalId })
    );
    const attrs = (attrsResp.Attributes ?? [])
      .filter(
        (a): a is { Key: string; Value: string } =>
          typeof a.Key === 'string' && typeof a.Value === 'string'
      )
      .map((a) => ({ Key: a.Key, Value: a.Value }))
      .sort((a, b) => a.Key.localeCompare(b.Key));
    result['TargetGroupAttributes'] = attrs;
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    // Permission errors etc — leave key absent rather than firing
    // false drift on every run.
  }

  await this.attachRegisteredTargets(result, physicalId);
  await this.attachTags(result, physicalId);
  return result;
}

/**
 * Read the target group's REGISTERED targets back in CFn `Targets` shape via
 * `DescribeTargetHealth` (issue
 * [#1620](https://github.com/go-to-k/cdkd/issues/1620)).
 *
 * Two things make this safe to compare, and both were the reason `Targets`
 * sat in {@link getDriftUnknownPaths} until now:
 *
 *  - **Order.** AWS does not guarantee a readback order for the target list,
 *    and the drift comparator compares arrays positionally. The type now
 *    declares `Targets` in {@link getDriftUnorderedPaths}, which sorts the
 *    list on BOTH comparison sides — so a reorder is not drift.
 *  - **Draining.** Deregistration is asynchronous: a just-removed target
 *    keeps reporting for minutes with `TargetHealth.State === 'draining'`.
 *    Including one would freeze it into the deploy-time `observedProperties`
 *    snapshot and produce PERMANENT phantom drift against every later read,
 *    once it finally disappears. `draining` means "being removed", so the
 *    registered set deliberately excludes it. Every other state (`initial`
 *    right after `RegisterTargets`, `unused` for a target with no listener,
 *    `unhealthy`, `unavailable`) IS a registered target and is included —
 *    health is not registration.
 *
 * Two AWS-SUBSTITUTED values are dropped, because echoing back a value the
 * template never wrote is phantom drift against a `properties`-fallback
 * baseline — and, worse, a DESTRUCTIVE one: `updateTargetGroup` keys its
 * register / deregister diff on the whole `(Id, Port, AvailabilityZone,
 * QuicServerId)` tuple, so one extra member makes the SAME live target read as a different
 * one and `--revert` deregisters it.
 *
 *  - `Port` when it equals the target group's own port — what AWS
 *    substitutes for a target registered without one. (`toTargetDescriptions`
 *    closes the same gap from the other direction, so a template that DOES
 *    spell the port out still keys identically.)
 *  - `AvailabilityZone` unless the group is `ip`-typed and AWS reported
 *    something other than its `all` default. CFn only accepts the member for
 *    `ip` targets, and `DeregisterTargets` rejects it on an instance group.
 *
 * Known bound: if `DescribeTargetHealth` were to return an empty list in the
 * window right after `RegisterTargets`, the deploy-time snapshot would
 * freeze `Targets: []` against a template that declares some. Not observed —
 * `RegisterTargets` is synchronous and the integ's post-deploy drift run
 * sees all three fixture targets — and left unguarded deliberately, since
 * treating an empty readback as unreadable would also blind a legitimately
 * emptied target group.
 *
 * On error the key is left ABSENT rather than emitted empty. That is not
 * silent: against an observed baseline that HOLDS targets, an absent key
 * still reports them as drifted. It is the honest option available — the
 * read failed, so the live set is unknown — and it keeps `--revert` from
 * acting on a fabricated empty list.
 */
export async function attachRegisteredTargets(
  this: ELBv2Provider,
  result: Record<string, unknown>,
  targetGroupArn: string
): Promise<void> {
  try {
    const resp = await this.getClient().send(
      new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })
    );
    const groupPort = typeof result['Port'] === 'number' ? result['Port'] : undefined;
    const isIpTargetGroup = result['TargetType'] === 'ip';
    const targets: CfnTargetDescription[] = [];
    for (const desc of resp.TargetHealthDescriptions ?? []) {
      if (desc.TargetHealth?.State === 'draining') continue;
      const id = desc.Target?.Id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const port = desc.Target?.Port;
      const az = desc.Target?.AvailabilityZone;
      const quicServerId = desc.Target?.QuicServerId;
      targets.push({
        Id: id,
        ...(port !== undefined && port !== groupPort && { Port: port }),
        ...(isIpTargetGroup && az !== undefined && az !== 'all' && { AvailabilityZone: az }),
        // Echoed: the diff key includes it, so omitting it would make a
        // registered QUIC target read as a different tuple and be deregistered.
        ...(typeof quicServerId === 'string' &&
          quicServerId.length > 0 && { QuicServerId: quicServerId }),
      });
    }
    result['Targets'] = targets;
  } catch (err) {
    // Permission errors etc — leave the key absent rather than reporting
    // every registered target as removed. Swallowed (not NotFound-mapped to
    // `undefined` like the attributes read above) because the
    // DescribeTargetGroups + DescribeTargetGroupAttributes calls that
    // precede it already surface a deleted target group; this mirrors
    // `attachTags`, the sibling best-effort enrichment.
    this.logger.debug(
      `ELBv2 DescribeTargetHealth(${targetGroupArn}) failed: ${describeAwsFailure(err).detail}`
    );
  }
}

/**
 * `Targets` is scoped PER RESOURCE (issue
 * [#1602](https://github.com/go-to-k/cdkd/issues/1602)'s seam), not switched
 * off for the type: it is compared only for a target group whose TEMPLATE
 * declares `Targets`.
 *
 * The reason is the issue [#1498](https://github.com/go-to-k/cdkd/issues/1498)
 * class. A target group fronting an ECS service or an ASG declares NO
 * `Targets` — the sibling resource registers them, and it keeps
 * re-registering as it scales. Comparing an undeclared target list would
 * therefore report drift on every scale event of an untouched stack, and
 * `--revert` would DEREGISTER the tasks the service just placed. The
 * `undeclaredEmptyObservedKeys` guard only covers the case where the capture
 * happened to be EMPTY, which for a redeployed running service it is not.
 *
 * An absent properties bag falls back to COMPARING, per the method's
 * contract — hiding real drift is the worse failure, and the only caller
 * that omits the bag today is not `cdkd drift`.
 */
export function getDriftUnknownPaths(
  this: ELBv2Provider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  switch (resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      // EnableCapacityReservationProvisionStabilize is a CFn-only
      // orchestration flag (wait-for-provisioned opt-in) with no AWS-side
      // readback — it is not a resource property on the wire.
      return ['EnableCapacityReservationProvisionStabilize'];
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      if (
        properties !== undefined &&
        Object.keys(properties).length > 0 &&
        properties['Targets'] === undefined
      ) {
        return ['Targets'];
      }
      return [];
    default:
      return [];
  }
}

/**
 * `Targets` is a semantically UNORDERED set: `RegisterTargets` /
 * `DeregisterTargets` are set operations (the provider's own update path
 * key-diffs them rather than comparing positions), and `DescribeTargetHealth`
 * documents no ordering guarantee. Declared here rather than sorted inside
 * {@link attachRegisteredTargets} so the sort applies to BOTH comparison
 * sides — see {@link ResourceProvider.getDriftUnorderedPaths}, whose header
 * records why one-sided sorting manufactures drift on the
 * `properties`-fallback baseline.
 *
 * `TargetGroupAttributes` needs no declaration: it is a `{Key, Value}` list,
 * which the shared tag-list canonicalizer already sorts on both sides.
 */
export function getDriftUnorderedPaths(this: ELBv2Provider, resourceType: string): string[] {
  if (resourceType !== 'AWS::ElasticLoadBalancingV2::TargetGroup') return [];
  return ['Targets'];
}

/**
 * Drop from the BASELINE an attribute-bag entry whose key the template never
 * declared and the readback no longer reports (go-to-k/cdkd#4144).
 *
 * The attribute readbacks emit every key AWS returns, and the observed
 * baseline captured the same. AWS can stop returning an undeclared key
 * (`ddos_protection.syn_cookie.mode` came and went between two reads of one
 * ALB), and nobody out-of-band can cause that: the Modify*Attributes APIs
 * set values and never remove a key. The key set otherwise moves only with
 * the resource's own configuration (a listener's protocol), which is compared
 * on its own. So that one-sided absence is not drift, and `--revert` must not
 * write the key back.
 *
 * Still compared: a DECLARED key that changed or vanished, an undeclared key
 * present on both sides, and a key only the readback holds. Fails closed
 * (identity) when the readback bag is not an array (its read failed) or is
 * empty (a degenerate reply), or the
 * declared bag is present but not a list of string `Key`s, since then which
 * keys are declared is unknown.
 *
 * Only the baseline is trimmed, so `--accept` (which writes the readback
 * side) persists nothing new. `--revert` sends this baseline as its desired
 * side against the readback as previous; the dropped key is on neither, so
 * `diffAttributes` submits nothing for it.
 */
export async function canonicalizeDriftPair(
  this: ELBv2Provider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties?: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  const unchanged = { baseline, aws };
  const bagKey = ATTRIBUTE_BAG_BY_TYPE.get(resourceType);
  if (bagKey === undefined) return unchanged;
  const recorded = baseline[bagKey];
  const live = aws[bagKey];
  // An EMPTY readback is a degenerate read (no `Attributes` in the reply),
  // not a report that every key vanished: dropping on it would hide the bag.
  if (!Array.isArray(recorded) || !Array.isArray(live) || live.length === 0) return unchanged;
  const declared = properties?.[bagKey];
  const declaredKeys = new Set<string>();
  if (declared !== undefined) {
    if (!Array.isArray(declared)) return unchanged;
    for (const entry of declared) {
      const key = attributeEntryKey(entry);
      if (key === undefined) return unchanged;
      declaredKeys.add(key);
    }
  }
  const liveKeys = new Set<string>();
  for (const entry of live) {
    const key = attributeEntryKey(entry);
    if (key !== undefined) liveKeys.add(key);
  }
  const kept = recorded.filter((entry) => {
    const key = attributeEntryKey(entry);
    return key === undefined || declaredKeys.has(key) || liveKeys.has(key);
  });
  if (kept.length === recorded.length) return unchanged;
  return { baseline: { ...baseline, [bagKey]: kept }, aws };
}

export async function readListener(
  this: ELBv2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let listener;
  try {
    const resp = await this.getClient().send(
      new DescribeListenersCommand({ ListenerArns: [physicalId] })
    );
    listener = resp.Listeners?.[0];
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    throw err;
  }
  if (!listener) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (listener.LoadBalancerArn !== undefined) {
    result['LoadBalancerArn'] = listener.LoadBalancerArn;
  }
  if (listener.Port !== undefined) result['Port'] = listener.Port;
  if (listener.Protocol !== undefined) result['Protocol'] = listener.Protocol;
  if (listener.SslPolicy !== undefined) result['SslPolicy'] = listener.SslPolicy;
  result['Certificates'] = (listener.Certificates ?? []).map((c) => {
    const out: Record<string, unknown> = {};
    if (c.CertificateArn !== undefined) out['CertificateArn'] = c.CertificateArn;
    if (c.IsDefault !== undefined) out['IsDefault'] = c.IsDefault;
    return out;
  });
  // CDK already uses PascalCase that matches AWS SDK shape; pass through
  // the keys the SDK returns. Cast to unknown via Record so the
  // comparator's deep-equal handles the structured comparison.
  result['DefaultActions'] = (listener.DefaultActions ?? []).map(
    (a) => a as unknown as Record<string, unknown>
  );
  // AlpnPolicy / MutualAuthentication are conditional on listener
  // protocol but always-emitted as user-controllable knobs so the v3
  // observedProperties baseline catches console-side ADDs (PR #145
  // pattern). AlpnPolicy is `[]` for non-TLS listeners; the
  // `MutualAuthentication` placeholder mirrors the `{}` shape AWS
  // returns when a user toggles it on.
  result['AlpnPolicy'] = listener.AlpnPolicy ?? [];
  result['MutualAuthentication'] = listener.MutualAuthentication ?? {};

  // ListenerAttributes via DescribeListenerAttributes. AWS returns the FULL
  // attribute set (every key valid for this listener type, including
  // AWS-defaulted values the user did not template). Sort by Key for a
  // stable positional compare and emit the whole list, so a console-side
  // change to any attribute surfaces as drift on the v3 observedProperties
  // baseline (which captures the same full set at deploy time) — the same
  // model as LoadBalancerAttributes above.
  try {
    const attrsResp = await this.getClient().send(
      new DescribeListenerAttributesCommand({ ListenerArn: physicalId })
    );
    const attrs = (attrsResp.Attributes ?? [])
      .filter(
        (a): a is { Key: string; Value: string } =>
          typeof a.Key === 'string' && typeof a.Value === 'string'
      )
      .map((a) => ({ Key: a.Key, Value: a.Value }))
      .sort((a, b) => a.Key.localeCompare(b.Key));
    result['ListenerAttributes'] = attrs;
  } catch (err) {
    if (isElbv2NotFoundName(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    // Permission errors etc — leave key absent rather than firing
    // false drift on every run.
  }

  await this.attachTags(result, physicalId);
  return result;
}

/** Best-effort tag fetch via `DescribeTags(ResourceArns=[arn])`. */
export async function attachTags(
  this: ELBv2Provider,
  result: Record<string, unknown>,
  arn: string
): Promise<void> {
  try {
    const resp = await this.getClient().send(new DescribeTagsCommand({ ResourceArns: [arn] }));
    const tagDesc = resp.TagDescriptions?.[0];
    const tags = normalizeAwsTagsToCfn(tagDesc?.Tags);
    result['Tags'] = tags;
  } catch (err) {
    this.logger.debug(`ELBv2 DescribeTags(${arn}) failed: ${describeAwsFailure(err).detail}`);
  }
}
