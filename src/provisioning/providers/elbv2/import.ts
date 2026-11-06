import type { ELBv2Provider } from '../elbv2-provider.js';
import {
  DescribeLoadBalancersCommand,
  type DescribeLoadBalancersCommandOutput,
  DescribeTargetGroupsCommand,
  type DescribeTargetGroupsCommandOutput,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { lookupEachName } from '../../name-lookup.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import {
  sentElbv2Name,
  explicitElbv2Name,
  onlyNamedMatch,
  loadBalancerAttributes,
  targetGroupAttributes,
} from './shared.js';

/**
 * Adopt an existing ELBv2 LoadBalancer or TargetGroup into cdkd state.
 *
 * Lookup: `--resource <id>=<arn>` override → verify with
 * `DescribeLoadBalancers` or `DescribeTargetGroups`. Without one, a
 * template `Name` is looked up by the name the create would send
 * ({@link sentElbv2Name}); with neither, the resource is reported as
 * not-found.
 *
 * The by-name lookup is also the go-to-k/cdkd#3937 name probe: both creates
 * answer success with the existing resource when one of that name has the
 * same settings, so the deploy asks here first. Only the service's own
 * not-found error reads as free: anything else, more than one match, or an
 * answer naming none throws, which the probe refuses on.
 *
 * Listener is likewise not auto-importable (no template-supplied stable
 * identifier); use `--resource <listenerId>=<arn>` for those.
 */
/**
 * go-to-k/cdkd#4705: the name a load balancer's or target group's
 * `create()` sends when the template names none (`sentElbv2Name`).
 */
export function generatedCreateName(
  this: ELBv2Provider,
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>
): string | undefined {
  if (
    resourceType !== 'AWS::ElasticLoadBalancingV2::LoadBalancer' &&
    resourceType !== 'AWS::ElasticLoadBalancingV2::TargetGroup'
  ) {
    return undefined;
  }
  // Any declared Name -- a string, a number, or an intrinsic not yet
  // resolved -- is not a generated one (go-to-k/cdkd#4705 review CB-13).
  const declared = properties['Name'];
  if (declared !== undefined && declared !== null && declared !== '') return undefined;
  return sentElbv2Name(properties, logicalId);
}

/**
 * go-to-k/cdkd#4705: a load balancer's `CreatedTime` (epoch ms), so a kept
 * one licenses only a holder created no later than it was kept. A target
 * group reports none.
 */
export async function holderCreatedAt(
  this: ELBv2Provider,
  resourceType: string,
  physicalId: string
): Promise<number | undefined> {
  if (resourceType !== 'AWS::ElasticLoadBalancingV2::LoadBalancer') return undefined;
  const resp = await this.getClient().send(
    new DescribeLoadBalancersCommand({ LoadBalancerArns: [physicalId] })
  );
  const created = resp.LoadBalancers?.[0]?.CreatedTime;
  return created instanceof Date ? created.getTime() : undefined;
}

/**
 * go-to-k/cdkd#4705: one exact `Describe...` with `Names: [name]` per name
 * (a `Names` batch fails outright when any one name is missing, which on a
 * first deploy is every time), never a region listing, which can omit a
 * resource just created. Any failure but the not-found error throws, which
 * refuses the create. The physical id is the ARN.
 */
export async function lookupNames(
  this: ELBv2Provider,
  resourceType: string,
  names: readonly string[]
): Promise<Map<string, string>> {
  const lb = resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer';
  if (!lb && resourceType !== 'AWS::ElasticLoadBalancingV2::TargetGroup') return new Map();
  const api = lb ? 'elbv2:DescribeLoadBalancers' : 'elbv2:DescribeTargetGroups';
  return lookupEachName(names, api, 3, async (name) => {
    try {
      if (lb) {
        const resp = await this.getClient().send(
          new DescribeLoadBalancersCommand({ Names: [name] })
        );
        return onlyNamedMatch(resp.LoadBalancers, (l) => l.LoadBalancerArn, 'load balancer').arn;
      }
      const resp = await this.getClient().send(new DescribeTargetGroupsCommand({ Names: [name] }));
      return onlyNamedMatch(resp.TargetGroups, (t) => t.TargetGroupArn, 'target group').arn;
    } catch (err) {
      const errName = (err as { name?: unknown }).name;
      if (
        errName === 'LoadBalancerNotFoundException' ||
        errName === 'TargetGroupNotFoundException'
      ) {
        return undefined;
      }
      throw err;
    }
  });
}

export async function importImpl(
  this: ELBv2Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return this.importLoadBalancer(input);
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      return this.importTargetGroup(input);
    case 'AWS::ElasticLoadBalancingV2::Listener':
      // Listener: only honor explicit overrides.
      if (input.knownPhysicalId) {
        return { physicalId: input.knownPhysicalId, attributes: {} };
      }
      return null;
    default:
      return null;
  }
}

export async function importLoadBalancer(
  this: ELBv2Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeLoadBalancersCommand({ LoadBalancerArns: [input.knownPhysicalId] })
      );
      // Issue #3627: the same map `create()` records; the resolver has no
      // ELBv2 arm, so without it every attribute resolved to the ARN.
      const lb = resp.LoadBalancers?.[0];
      return lb?.LoadBalancerArn
        ? {
            physicalId: lb.LoadBalancerArn,
            attributes: loadBalancerAttributes(lb, lb.LoadBalancerArn),
          }
        : null;
    } catch (err) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Without a template `Name` there is nothing to look up.
  const name = explicitElbv2Name(input);
  if (name === undefined) return null;
  let resp: DescribeLoadBalancersCommandOutput;
  try {
    resp = await this.getClient().send(new DescribeLoadBalancersCommand({ Names: [name] }));
  } catch (err) {
    // By ERROR NAME only: `isNotFoundError` also matches message text, and
    // a lookup that did not answer must never read as "the name is free".
    if ((err as { name?: unknown }).name === 'LoadBalancerNotFoundException') return null;
    throw err;
  }
  const lb = onlyNamedMatch(resp.LoadBalancers, (l) => l.LoadBalancerArn, 'load balancer');
  return { physicalId: lb.arn, attributes: loadBalancerAttributes(lb.item, lb.arn) };
}

export async function importTargetGroup(
  this: ELBv2Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [input.knownPhysicalId] })
      );
      // Issue #3627: the same map `create()` records.
      const tg = resp.TargetGroups?.[0];
      return tg?.TargetGroupArn
        ? {
            physicalId: tg.TargetGroupArn,
            attributes: targetGroupAttributes(tg, tg.TargetGroupArn),
          }
        : null;
    } catch (err) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk (issue #1134); without a template `Name`
  // there is nothing to look up.
  const name = explicitElbv2Name(input);
  if (name === undefined) return null;
  let resp: DescribeTargetGroupsCommandOutput;
  try {
    resp = await this.getClient().send(new DescribeTargetGroupsCommand({ Names: [name] }));
  } catch (err) {
    // By ERROR NAME only, as for the load balancer lookup.
    if ((err as { name?: unknown }).name === 'TargetGroupNotFoundException') return null;
    throw err;
  }
  const tg = onlyNamedMatch(resp.TargetGroups, (t) => t.TargetGroupArn, 'target group');
  return { physicalId: tg.arn, attributes: targetGroupAttributes(tg.item, tg.arn) };
}
