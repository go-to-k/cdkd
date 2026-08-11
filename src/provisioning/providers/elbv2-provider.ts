import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancersCommand,
  waitUntilLoadBalancerAvailable,
  DescribeLoadBalancerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
  SetSubnetsCommand,
  SetSecurityGroupsCommand,
  SetIpAddressTypeCommand,
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  ModifyTargetGroupCommand,
  DescribeTargetGroupsCommand,
  ModifyTargetGroupAttributesCommand,
  DescribeTargetGroupAttributesCommand,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
  ModifyCapacityReservationCommand,
  DescribeCapacityReservationCommand,
  ModifyIpPoolsCommand,
  DescribeTagsCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  CreateListenerCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  DescribeListenersCommand,
  ModifyListenerAttributesCommand,
  DescribeListenerAttributesCommand,
  type Tag,
  type Action,
  type Certificate,
  type SubnetMapping,
  type LoadBalancerSchemeEnum,
  type LoadBalancerTypeEnum,
  type IpAddressType,
  type ProtocolEnum,
  type TargetTypeEnum,
  type MutualAuthenticationAttributes,
  type EnablePrefixForIpv6SourceNatEnum,
  type EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum,
  type TargetGroupIpAddressTypeEnum,
  type TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { getLogger } from '../../utils/logger.js';
import { withRetry } from '../../deployment/retry.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { isTruthyCfnBoolean } from '../data-delete-intent.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * Test seam for the capacity-reservation stabilize poll (mirrors
 * `finalSnapshotDelays` in ../final-snapshot.ts). Unit tests stub `sleep`
 * so the poll runs without wall-clock delay.
 */
export const capacityReservationDelays = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** CFn shape of an `AWS::ElasticLoadBalancingV2::TargetGroup.Targets` entry. */
interface CfnTargetDescription {
  Id?: string;
  Port?: number | string;
  AvailabilityZone?: string;
}

/**
 * Documented AWS defaults for TargetGroup attributes, used to reset a
 * removed `TargetGroupAttributes` entry. Unlike ModifyLoadBalancerAttributes
 * / ModifyListenerAttributes, ModifyTargetGroupAttributes REJECTS an empty
 * `Value` ("A target group attribute value must be specified" — live-verified
 * 2026-08-11), so clearing an override requires sending the documented
 * default explicitly. Keys whose default is target-type-dependent or
 * undocumented are deliberately absent — a removal of those warns and
 * retains the live value instead of guessing.
 * Source: ELBv2 API reference, TargetGroupAttribute key table.
 */
const TARGET_GROUP_ATTRIBUTE_DEFAULTS: Record<string, string> = {
  'deregistration_delay.timeout_seconds': '300',
  'deregistration_delay.connection_termination.enabled': 'false',
  'stickiness.enabled': 'false',
  'stickiness.lb_cookie.duration_seconds': '86400',
  'stickiness.app_cookie.duration_seconds': '86400',
  'load_balancing.algorithm.type': 'round_robin',
  'load_balancing.algorithm.anomaly_mitigation': 'off',
  'load_balancing.cross_zone.enabled': 'use_load_balancer_configuration',
  'slow_start.duration_seconds': '0',
  'lambda.multi_value_headers.enabled': 'false',
  'proxy_protocol_v2.enabled': 'false',
};

/**
 * Documented AWS defaults for the BOOLEAN / ENUM-valued LoadBalancer and
 * Listener attributes, used to reset a removed `LoadBalancerAttributes` /
 * `ListenerAttributes` entry.
 *
 * Unlike ModifyTargetGroupAttributes — which rejects an empty `Value` for
 * EVERY key — these two APIs accept `Value: ''` for the numeric and
 * free-form string attributes and REJECT it only where the value is
 * validated against a fixed set. Live A/B 2026-08-11 (issue #1609 item 1),
 * via the `alb` integ's removal phase:
 *
 *   idle_timeout.timeout_seconds  -> `Value: ''` ACCEPTED (numeric)
 *   deletion_protection.enabled   -> "The value of 'deletion_protection.enabled'
 *                                     must be 'true' or 'false', but was ''"
 *   routing.http.response.server.enabled (Listener)
 *                                 -> same rejection, same shape
 *
 * A rejection fails the whole Modify* call, so ONE removed boolean took the
 * entire deploy down (and then the rollback with it). Hence: send the
 * documented default for the validated keys, and keep the empty string for
 * everything else — which is both these APIs' own "clear the override"
 * signal and the behaviour every non-boolean key already relied on.
 *
 * That fallback is the deliberate DIVERGENCE from
 * TARGET_GROUP_ATTRIBUTE_DEFAULTS, whose unknown-key arm warns and retains:
 * there the empty string is never valid, here it is valid for the majority
 * of keys, so falling back to it preserves working behaviour instead of
 * silently retaining a value the template asked to drop.
 *
 * Keys whose default is LOAD-BALANCER-TYPE-dependent are deliberately absent
 * (`load_balancing.cross_zone.enabled` is always-on and unconfigurable for an
 * ALB but defaults to false on an NLB / GWLB, so cdkd cannot pick one without
 * knowing the type at diff time) — those keep the empty-string behaviour they
 * have always had.
 * Source: ELBv2 API reference, LoadBalancerAttribute / ListenerAttribute key
 * tables.
 */
const LOAD_BALANCER_ATTRIBUTE_DEFAULTS: Record<string, string> = {
  'deletion_protection.enabled': 'false',
  'access_logs.s3.enabled': 'false',
  'connection_logs.s3.enabled': 'false',
  'ipv6.deny_all_igw_traffic': 'false',
  'routing.http.desync_mitigation_mode': 'defensive',
  'routing.http.drop_invalid_header_fields.enabled': 'false',
  'routing.http.preserve_host_header.enabled': 'false',
  'routing.http.x_amzn_tls_version_and_cipher_suite.enabled': 'false',
  'routing.http.xff_client_port.enabled': 'false',
  'routing.http.xff_header_processing.mode': 'append',
  'routing.http2.enabled': 'true',
  'waf.fail_open.enabled': 'false',
  'zonal_shift.config.enabled': 'false',
  'dns_record.client_routing_policy': 'any_availability_zone',
};

/** @see LOAD_BALANCER_ATTRIBUTE_DEFAULTS — same rule, Listener key table. */
const LISTENER_ATTRIBUTE_DEFAULTS: Record<string, string> = {
  'routing.http.response.server.enabled': 'true',
};

/**
 * AWS ELBv2 Provider
 *
 * Implements resource provisioning for ELBv2 resources:
 * - AWS::ElasticLoadBalancingV2::LoadBalancer
 * - AWS::ElasticLoadBalancingV2::TargetGroup
 * - AWS::ElasticLoadBalancingV2::Listener
 *
 * WHY: ELBv2 Create* APIs are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling.
 *
 * "The API is synchronous" is NOT the same claim as "the resource is ready",
 * and an earlier version of this comment conflated the two. TargetGroup and
 * Listener genuinely are ready on return; a LoadBalancer comes back with
 * `State.Code: provisioning` and is not servable for another 90-180s. So
 * createLoadBalancer waits for `active` (skippable with --no-wait) while the
 * other two do not.
 */
export class ELBv2Provider implements ResourceProvider {
  private elbv2Client?: ElasticLoadBalancingV2Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ELBv2Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      new Set([
        'Name',
        'Subnets',
        'SubnetMappings',
        'SecurityGroups',
        'Scheme',
        'Type',
        'IpAddressType',
        'LoadBalancerAttributes',
        'Tags',
        'EnablePrefixForIpv6SourceNat',
        'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
        'Ipv4IpamPoolId',
        'MinimumLoadBalancerCapacity',
        'EnableCapacityReservationProvisionStabilize',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      new Set([
        'Protocol',
        'Port',
        'VpcId',
        'TargetType',
        'ProtocolVersion',
        'HealthCheckProtocol',
        'HealthCheckPort',
        'HealthCheckPath',
        'HealthCheckEnabled',
        'HealthCheckIntervalSeconds',
        'HealthCheckTimeoutSeconds',
        'HealthyThresholdCount',
        'UnhealthyThresholdCount',
        'Matcher',
        'Name',
        'Tags',
        'IpAddressType',
        'TargetControlPort',
        'TargetGroupAttributes',
        'Targets',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::Listener',
      new Set([
        'LoadBalancerArn',
        'Certificates',
        'DefaultActions',
        'Port',
        'Protocol',
        'SslPolicy',
        'AlpnPolicy',
        'MutualAuthentication',
        'ListenerAttributes',
      ]),
    ],
  ]);

  private getClient(): ElasticLoadBalancingV2Client {
    if (!this.elbv2Client) {
      this.elbv2Client = new ElasticLoadBalancingV2Client(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.elbv2Client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.createLoadBalancer(logicalId, resourceType, properties);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.createTargetGroup(logicalId, resourceType, properties);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.createListener(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and an inner
      // ProvisioningError already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update ELBv2 resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.updateLoadBalancer(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.updateTargetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.updateListener(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.deleteLoadBalancer(logicalId, physicalId, resourceType, context);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.deleteTargetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.deleteListener(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::LoadBalancer ─────────────────────

  private async createLoadBalancer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating LoadBalancer ${logicalId}`);

    try {
      const tags = this.extractTags(properties);

      const lbName = generateResourceNameWithFallback(
        properties['Name'] as string | undefined,
        logicalId,
        { maxLength: 32 }
      );

      const ipv4IpamPoolId = properties['Ipv4IpamPoolId'] as string | undefined;
      const response = await this.getClient().send(
        new CreateLoadBalancerCommand({
          Name: lbName,
          Subnets: properties['Subnets'] as string[] | undefined,
          SubnetMappings: properties['SubnetMappings'] as
            | Array<{ SubnetId: string; AllocationId?: string; PrivateIPv4Address?: string }>
            | undefined,
          SecurityGroups: properties['SecurityGroups'] as string[] | undefined,
          Scheme: properties['Scheme'] as LoadBalancerSchemeEnum | undefined,
          Type: properties['Type'] as LoadBalancerTypeEnum | undefined,
          IpAddressType: properties['IpAddressType'] as IpAddressType | undefined,
          EnablePrefixForIpv6SourceNat: properties['EnablePrefixForIpv6SourceNat'] as
            | EnablePrefixForIpv6SourceNatEnum
            | undefined,
          // CFn flattens the SDK's `IpamPools` wrapper to a single
          // `Ipv4IpamPoolId` string (ipv4 is the only pool kind today).
          ...(ipv4IpamPoolId !== undefined && { IpamPools: { Ipv4IpamPoolId: ipv4IpamPoolId } }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const lb = response.LoadBalancers?.[0];
      if (!lb || !lb.LoadBalancerArn) {
        // Theoretical AWS SDK contract violation: CreateLoadBalancer
        // returned success but with no LoadBalancerArn. Cannot clean up
        // — we have no ARN to delete. Has never been observed in
        // practice.
        throw new Error('CreateLoadBalancer did not return LoadBalancer ARN');
      }
      const lbArn = lb.LoadBalancerArn;

      this.logger.debug(`Successfully created LoadBalancer ${logicalId}: ${lbArn}`);

      // CreateLoadBalancerCommand has succeeded — AWS has now committed
      // the LB. If the subsequent ModifyLoadBalancerAttributesCommand
      // throws, the LB exists on AWS but cdkd state will NOT (the throw
      // aborts before the success-return). The next redeploy plans
      // CREATE again and AWS rejects with `DuplicateLoadBalancerName`
      // (LB Names are unique per scheme within a region). Wrap the
      // attributes call in an inner try/catch that issues a best-effort
      // `DeleteLoadBalancerCommand` before re-throwing the original
      // error. A freshly-created LB has no listeners / target group
      // attachments yet, so a single DeleteLoadBalancer suffices (no
      // need to delete listeners first).
      try {
        // Wait for the LB to leave `provisioning` and reach `active`
        // unless --no-wait is set. CreateLoadBalancer returns a fully
        // formed LoadBalancer object synchronously, but with
        // `State.Code: provisioning` — the LB is NOT servable yet, and
        // `DNSName` (returned below as a GetAtt attribute) 503s until it
        // is. Both other engines wait here: CloudFormation before
        // CREATE_COMPLETE, Terraform's `aws_lb` before apply returns.
        //
        // Deliberately INSIDE the partial-create cleanup try/catch: a
        // waiter timeout with the LB already created on AWS but absent
        // from cdkd state would make the next deploy fail with
        // DuplicateLoadBalancerName (LB names are unique per scheme per
        // region), so it has to route through the same best-effort
        // DeleteLoadBalancer as an attributes-wiring failure. The cleanup
        // NARROWS that window rather than closing it — LB deletion is
        // asynchronous and outlives the DeleteLoadBalancer call, so an
        // immediate retry can still hit the duplicate-name error (issue
        // #1291 item 4).
        //
        // Create only. SetSubnets / SetSecurityGroups / SetIpAddressType
        // on update act on an already-active LB and need no waiter.
        if (process.env['CDKD_NO_WAIT'] !== 'true') {
          this.logger.debug(`Waiting for LoadBalancer ${logicalId} to reach active state...`);
          await waitUntilLoadBalancerAvailable(
            // 600s matches Terraform's default `aws_lb` create timeout.
            // minDelay/maxDelay override the AWS SDK defaults (15s / 120s)
            // per the #1177 poll-cap sweep: an ALB reaches `active` in
            // 90-180s, so a 120s-apart late poll can add minutes of dead
            // time to every deploy that creates one.
            { client: this.getClient(), maxWaitTime: 600, minDelay: 5, maxDelay: 10 },
            { LoadBalancerArns: [lbArn] }
          );
          this.logger.debug(`LoadBalancer ${logicalId} is active`);
        } else {
          this.logger.debug(
            `LoadBalancer ${logicalId} created (skipping active-state wait per --no-wait)`
          );
        }

        // Apply LoadBalancerAttributes if specified (normalized so an
        // unquoted-YAML numeric/boolean Value goes on the wire as a string,
        // matching the TG / Listener create paths).
        const lbAttributes = this.normalizeAttributes(properties['LoadBalancerAttributes']);
        if (lbAttributes.length > 0) {
          await this.getClient().send(
            new ModifyLoadBalancerAttributesCommand({
              LoadBalancerArn: lbArn,
              Attributes: lbAttributes,
            })
          );
          this.logger.debug(
            `Applied ${lbAttributes.length} LoadBalancer attributes for ${logicalId}`
          );
        }

        // EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic has no
        // CreateLoadBalancer member — the only write path is SetSecurityGroups,
        // so re-issue the create-time security groups with the flag when the
        // template carries it (NLB + security-groups only; AWS rejects it
        // elsewhere and the error surfaces through the cleanup catch).
        const enforcePrivateLink = properties[
          'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'
        ] as EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum | undefined;
        if (enforcePrivateLink !== undefined) {
          await this.getClient().send(
            new SetSecurityGroupsCommand({
              LoadBalancerArn: lbArn,
              SecurityGroups: (properties['SecurityGroups'] as string[] | undefined) ?? [],
              EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: enforcePrivateLink,
            })
          );
          this.logger.debug(
            `Applied EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic=${enforcePrivateLink} for ${logicalId}`
          );
        }

        // MinimumLoadBalancerCapacity rides on the separate
        // ModifyCapacityReservation control-plane call (no CreateLoadBalancer
        // member). EnableCapacityReservationProvisionStabilize is a CFn-only
        // orchestration flag with NO SDK member: it opts the deploy into
        // waiting for the reservation to reach `provisioned` before success.
        const minCapacity = properties['MinimumLoadBalancerCapacity'] as
          | { CapacityUnits?: number | string }
          | undefined;
        if (minCapacity?.CapacityUnits !== undefined) {
          await this.getClient().send(
            new ModifyCapacityReservationCommand({
              LoadBalancerArn: lbArn,
              MinimumLoadBalancerCapacity: {
                CapacityUnits: Number(minCapacity.CapacityUnits),
              },
            })
          );
          this.logger.debug(
            `Requested capacity reservation of ${minCapacity.CapacityUnits} LCU for ${logicalId}`
          );
          if (
            isTruthyCfnBoolean(properties['EnableCapacityReservationProvisionStabilize']) &&
            process.env['CDKD_NO_WAIT'] !== 'true'
          ) {
            await this.waitForCapacityReservationProvisioned(lbArn, logicalId);
          }
        }
      } catch (innerError) {
        try {
          await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: lbArn }));
          this.logger.debug(
            `Cleaned up partially-created LoadBalancer ${logicalId} (${lbArn}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created LoadBalancer ${logicalId} (${lbArn}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws elbv2 delete-load-balancer --load-balancer-arn ${lbArn}`
          );
        }
        throw innerError;
      }

      return {
        physicalId: lbArn,
        attributes: {
          DNSName: lb.DNSName,
          CanonicalHostedZoneID: lb.CanonicalHostedZoneId,
          LoadBalancerArn: lbArn,
          LoadBalancerFullName: lbArn.split('/').slice(1).join('/'),
          LoadBalancerName: lb.LoadBalancerName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create LoadBalancer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateLoadBalancer(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // ELBv2 LoadBalancer Name / Type / Scheme are immutable after
    // creation. The deploy engine detects these via immutable-property
    // detection and replaces the resource. The remaining surface is
    // mutable in-place via separate Set*/Modify* calls:
    //   - LoadBalancerAttributes → ModifyLoadBalancerAttributes (key diff)
    //   - Subnets / SubnetMappings / EnablePrefixForIpv6SourceNat → SetSubnets
    //   - SecurityGroups / EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic
    //     → SetSecurityGroups (full replace)
    //   - IpAddressType → SetIpAddressType
    //   - Ipv4IpamPoolId → ModifyIpPools (removal → RemoveIpamPools)
    //   - MinimumLoadBalancerCapacity → ModifyCapacityReservation
    //     (removal → ResetCapacityReservation; the
    //     EnableCapacityReservationProvisionStabilize flag gates a
    //     provisioned-state wait, not an API field)
    //   - Tags → AddTags / RemoveTags (key diff)
    // Any other diff (Name / Type / Scheme) rejects with
    // ResourceUpdateNotSupportedError so `cdkd drift --revert` surfaces
    // the limitation instead of silently no-op'ing.
    const handledKeys = new Set([
      'LoadBalancerAttributes',
      'Subnets',
      'SubnetMappings',
      'SecurityGroups',
      'IpAddressType',
      'Tags',
      'EnablePrefixForIpv6SourceNat',
      'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
      'Ipv4IpamPoolId',
      'MinimumLoadBalancerCapacity',
      'EnableCapacityReservationProvisionStabilize',
    ]);
    const stripHandled = (p: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) {
        if (!handledKeys.has(k)) out[k] = v;
      }
      return out;
    };
    if (
      JSON.stringify(stripHandled(properties)) !== JSON.stringify(stripHandled(previousProperties))
    ) {
      throw new ResourceUpdateNotSupportedError(
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        logicalId,
        'ELBv2 LoadBalancer Name / Type / Scheme are immutable on AWS — none of the ELBv2 Modify* / Set* APIs accept these fields; they are fixed at creation. cdkd handles LoadBalancerAttributes / Subnets / SubnetMappings / SecurityGroups / IpAddressType / Tags in-place; for Name / Type / Scheme re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.'
      );
    }

    // ─── LoadBalancerAttributes ──────────────────────────────────────
    // ModifyLoadBalancerAttributes replaces ONLY the listed attrs — keys
    // not in the request are left untouched. Build the diff: changed
    // values from newAttrs win; keys present only in oldAttrs are reset.
    // A removed BOOLEAN / ENUM key takes its documented default from
    // LOAD_BALANCER_ATTRIBUTE_DEFAULTS because this API rejects an empty
    // Value for those (live-verified 2026-08-11 — see that table); every
    // other key keeps the empty string, which the API accepts as "clear the
    // override". Skip the call entirely when nothing changed so the
    // no-drift round-trip is a clean no-op.
    const submittedAttrs = this.diffAttributes(
      this.normalizeAttributes(properties['LoadBalancerAttributes']),
      this.normalizeAttributes(previousProperties['LoadBalancerAttributes']),
      (key) => LOAD_BALANCER_ATTRIBUTE_DEFAULTS[key] ?? ''
    );
    if (submittedAttrs.length > 0) {
      await this.getClient().send(
        new ModifyLoadBalancerAttributesCommand({
          LoadBalancerArn: physicalId,
          Attributes: submittedAttrs,
        })
      );
      this.logger.debug(
        `Applied ${submittedAttrs.length} LoadBalancerAttributes change(s) for ${logicalId}`
      );
    }

    // ─── Subnets / SubnetMappings ────────────────────────────────────
    // SetSubnets is a full-replace API: the request payload is the
    // complete desired set; AWS swaps in / out as needed. SubnetMappings
    // wins when both are present (matches CFn semantics — they're a
    // strict superset of Subnets). Skip the call when neither value
    // actually changed.
    const newSubnets = properties['Subnets'] as string[] | undefined;
    const oldSubnets = previousProperties['Subnets'] as string[] | undefined;
    const newMappings = properties['SubnetMappings'] as SubnetMapping[] | undefined;
    const oldMappings = previousProperties['SubnetMappings'] as SubnetMapping[] | undefined;
    const newIpv6SourceNat = properties['EnablePrefixForIpv6SourceNat'] as
      | EnablePrefixForIpv6SourceNatEnum
      | undefined;
    const oldIpv6SourceNat = previousProperties['EnablePrefixForIpv6SourceNat'] as
      | EnablePrefixForIpv6SourceNatEnum
      | undefined;
    const subnetsChanged = JSON.stringify(newSubnets) !== JSON.stringify(oldSubnets);
    const mappingsChanged = JSON.stringify(newMappings) !== JSON.stringify(oldMappings);
    // EnablePrefixForIpv6SourceNat rides on SetSubnets: a change re-issues the
    // current subnet set with the new flag. A REMOVED flag on its own is
    // retained (no call) — CFn retains most removed fields. Caveat: when the
    // flag is removed in the SAME deploy that changes Subnets, the Set call
    // omits the member and AWS's omission semantics (retain vs default) have
    // not been A/B-verified for that combination.
    const ipv6SourceNatChanged =
      newIpv6SourceNat !== undefined && newIpv6SourceNat !== oldIpv6SourceNat;
    if (subnetsChanged || mappingsChanged || ipv6SourceNatChanged) {
      await this.getClient().send(
        new SetSubnetsCommand({
          LoadBalancerArn: physicalId,
          ...(newMappings && newMappings.length > 0
            ? { SubnetMappings: newMappings }
            : { Subnets: newSubnets }),
          ...(newIpv6SourceNat !== undefined && {
            EnablePrefixForIpv6SourceNat: newIpv6SourceNat,
          }),
        })
      );
      this.logger.debug(`Updated Subnets / SubnetMappings for ${logicalId}`);
    }

    // ─── SecurityGroups ──────────────────────────────────────────────
    // SetSecurityGroups requires the full desired set (overrides the
    // previous association). Note: NLBs without a SG at create time
    // cannot have one added later — AWS will reject the call. That's
    // the deploy engine's replacement layer's problem; here we just
    // surface the AWS error if it fires.
    const newSGs = properties['SecurityGroups'] as string[] | undefined;
    const oldSGs = previousProperties['SecurityGroups'] as string[] | undefined;
    const newEnforce = properties['EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'] as
      | EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum
      | undefined;
    const oldEnforce = previousProperties[
      'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'
    ] as EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum | undefined;
    // EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic rides on
    // SetSecurityGroups: a change re-issues the current security-group set
    // with the new flag. A REMOVED flag is retained (no-op) — same rationale
    // as EnablePrefixForIpv6SourceNat above.
    const enforceChanged = newEnforce !== undefined && newEnforce !== oldEnforce;
    if (JSON.stringify(newSGs) !== JSON.stringify(oldSGs) || enforceChanged) {
      await this.getClient().send(
        new SetSecurityGroupsCommand({
          LoadBalancerArn: physicalId,
          SecurityGroups: newSGs ?? [],
          ...(newEnforce !== undefined && {
            EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: newEnforce,
          }),
        })
      );
      this.logger.debug(`Updated SecurityGroups for ${logicalId}`);
    }

    // ─── IpAddressType ───────────────────────────────────────────────
    const newIpType = properties['IpAddressType'] as IpAddressType | undefined;
    const oldIpType = previousProperties['IpAddressType'] as IpAddressType | undefined;
    if (newIpType !== undefined && newIpType !== oldIpType) {
      await this.getClient().send(
        new SetIpAddressTypeCommand({
          LoadBalancerArn: physicalId,
          IpAddressType: newIpType,
        })
      );
      this.logger.debug(`Updated IpAddressType for ${logicalId}`);
    }

    // ─── Ipv4IpamPoolId ──────────────────────────────────────────────
    // ModifyIpPools sets / removes the IPAM pool association. Removal has a
    // dedicated API spelling (RemoveIpamPools: ['ipv4']), so — unlike the two
    // Set* flags above — dropping the property from the template detaches
    // the pool instead of silently retaining it.
    const newIpamPool = properties['Ipv4IpamPoolId'] as string | undefined;
    const oldIpamPool = previousProperties['Ipv4IpamPoolId'] as string | undefined;
    if (newIpamPool !== oldIpamPool) {
      await this.getClient().send(
        new ModifyIpPoolsCommand({
          LoadBalancerArn: physicalId,
          ...(newIpamPool !== undefined
            ? { IpamPools: { Ipv4IpamPoolId: newIpamPool } }
            : { RemoveIpamPools: ['ipv4'] }),
        })
      );
      this.logger.debug(
        newIpamPool !== undefined
          ? `Updated Ipv4IpamPoolId for ${logicalId}`
          : `Removed IPAM pool association for ${logicalId}`
      );
    }

    // ─── MinimumLoadBalancerCapacity ─────────────────────────────────
    // ModifyCapacityReservation sets the reservation; removal resets it via
    // the dedicated ResetCapacityReservation flag (a capacity reservation is
    // billable, so retaining a removed one would silently keep charging).
    const newCapacity = properties['MinimumLoadBalancerCapacity'] as
      | { CapacityUnits?: number | string }
      | undefined;
    const oldCapacity = previousProperties['MinimumLoadBalancerCapacity'] as
      | { CapacityUnits?: number | string }
      | undefined;
    const newCapacityUnits =
      newCapacity?.CapacityUnits !== undefined ? Number(newCapacity.CapacityUnits) : undefined;
    const oldCapacityUnits =
      oldCapacity?.CapacityUnits !== undefined ? Number(oldCapacity.CapacityUnits) : undefined;
    if (newCapacityUnits !== oldCapacityUnits) {
      await this.getClient().send(
        new ModifyCapacityReservationCommand({
          LoadBalancerArn: physicalId,
          ...(newCapacityUnits !== undefined
            ? { MinimumLoadBalancerCapacity: { CapacityUnits: newCapacityUnits } }
            : { ResetCapacityReservation: true }),
        })
      );
      this.logger.debug(
        newCapacityUnits !== undefined
          ? `Requested capacity reservation of ${newCapacityUnits} LCU for ${logicalId}`
          : `Reset capacity reservation for ${logicalId}`
      );
      if (
        newCapacityUnits !== undefined &&
        isTruthyCfnBoolean(properties['EnableCapacityReservationProvisionStabilize']) &&
        process.env['CDKD_NO_WAIT'] !== 'true'
      ) {
        await this.waitForCapacityReservationProvisioned(physicalId, logicalId);
      }
    }

    // ─── Tags ────────────────────────────────────────────────────────
    await this.applyTagDiff(
      physicalId,
      previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
      properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
    );

    return { physicalId, wasReplaced: false };
  }

  /**
   * Poll DescribeCapacityReservation until every zonal state reports
   * `provisioned` — the semantics of the CFn-only
   * `EnableCapacityReservationProvisionStabilize` flag (no SDK member; it
   * opts the deploy into waiting for the reservation instead of returning
   * while zones are still `pending`). Bounded at ~10 min / 15s interval;
   * a timeout WARNS and continues (the reservation keeps provisioning
   * asynchronously and the ModifyCapacityReservation was accepted), while a
   * `failed` zonal state throws — that reservation will never provision.
   */
  private async waitForCapacityReservationProvisioned(
    lbArn: string,
    logicalId: string
  ): Promise<void> {
    const maxAttempts = 40;
    const intervalMs = 15_000;
    this.logger.debug(`Waiting for capacity reservation of ${logicalId} to provision...`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // A transient Describe failure (throttle, network blip) is treated as
      // still-pending rather than thrown: on the create path an escaped error
      // lands in the partial-create cleanup and would DELETE a healthy LB
      // whose reservation was merely pending. Only a `failed` zonal state —
      // a definitive answer from AWS — aborts the wait.
      let zones;
      try {
        const resp = await this.getClient().send(
          new DescribeCapacityReservationCommand({ LoadBalancerArn: lbArn })
        );
        zones = resp.CapacityReservationState ?? [];
      } catch (probeError) {
        this.logger.debug(
          `DescribeCapacityReservation for ${logicalId} failed transiently (attempt ${attempt + 1}/${maxAttempts}): ${probeError instanceof Error ? probeError.message : String(probeError)}`
        );
        await capacityReservationDelays.sleep(intervalMs);
        continue;
      }
      const failed = zones.find((z) => z.State?.Code === 'failed');
      if (failed) {
        throw new Error(
          `Capacity reservation for ${logicalId} failed in ${failed.AvailabilityZone ?? 'an availability zone'}: ${failed.State?.Reason ?? 'no reason reported'}`
        );
      }
      if (zones.length === 0 || zones.every((z) => z.State?.Code === 'provisioned')) {
        this.logger.debug(`Capacity reservation for ${logicalId} is provisioned`);
        return;
      }
      await capacityReservationDelays.sleep(intervalMs);
    }
    this.logger.warn(
      `Capacity reservation for ${logicalId} did not reach 'provisioned' within ${(maxAttempts * intervalMs) / 60000} minutes; continuing (provisioning completes asynchronously)`
    );
  }

  private async deleteLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting LoadBalancer ${logicalId}: ${physicalId}`);

    // `--remove-protection`: clear the `deletion_protection.enabled`
    // attribute before delete. Idempotent — ELBv2 accepts the call when
    // protection is already disabled. Non-fatal: log at debug if the
    // flip-off errors so the actual DeleteLoadBalancer proceeds.
    if (context?.removeProtection === true) {
      try {
        await this.getClient().send(
          new ModifyLoadBalancerAttributesCommand({
            LoadBalancerArn: physicalId,
            Attributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
          })
        );
        this.logger.debug(
          `Disabled deletion_protection.enabled on LoadBalancer ${logicalId} before delete`
        );
      } catch (flipError) {
        if (!this.isNotFoundError(flipError)) {
          this.logger.debug(
            `Could not disable deletion_protection.enabled on ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
          );
        }
      }
    }

    try {
      await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: physicalId }));
      this.logger.debug(`Successfully deleted LoadBalancer ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`LoadBalancer ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete LoadBalancer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::TargetGroup ──────────────────────

  private async createTargetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating TargetGroup ${logicalId}`);

    try {
      const tags = this.extractTags(properties);
      const matcher = properties['Matcher'] as { HttpCode?: string; GrpcCode?: string } | undefined;

      const tgName = generateResourceNameWithFallback(
        properties['Name'] as string | undefined,
        logicalId,
        { maxLength: 32 }
      );

      const response = await this.getClient().send(
        new CreateTargetGroupCommand({
          Name: tgName,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          VpcId: properties['VpcId'] as string | undefined,
          TargetType: properties['TargetType'] as TargetTypeEnum | undefined,
          ProtocolVersion: properties['ProtocolVersion'] as string | undefined,
          HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
          HealthCheckPort: properties['HealthCheckPort'] as string | undefined,
          HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
          HealthCheckEnabled:
            properties['HealthCheckEnabled'] !== undefined
              ? Boolean(properties['HealthCheckEnabled'])
              : undefined,
          HealthCheckIntervalSeconds:
            properties['HealthCheckIntervalSeconds'] !== undefined
              ? Number(properties['HealthCheckIntervalSeconds'])
              : undefined,
          HealthCheckTimeoutSeconds:
            properties['HealthCheckTimeoutSeconds'] !== undefined
              ? Number(properties['HealthCheckTimeoutSeconds'])
              : undefined,
          HealthyThresholdCount:
            properties['HealthyThresholdCount'] !== undefined
              ? Number(properties['HealthyThresholdCount'])
              : undefined,
          UnhealthyThresholdCount:
            properties['UnhealthyThresholdCount'] !== undefined
              ? Number(properties['UnhealthyThresholdCount'])
              : undefined,
          IpAddressType: properties['IpAddressType'] as TargetGroupIpAddressTypeEnum | undefined,
          TargetControlPort:
            properties['TargetControlPort'] !== undefined
              ? Number(properties['TargetControlPort'])
              : undefined,
          ...(matcher && { Matcher: matcher }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const tg = response.TargetGroups?.[0];
      if (!tg || !tg.TargetGroupArn) {
        throw new Error('CreateTargetGroup did not return TargetGroup ARN');
      }
      const tgArn = tg.TargetGroupArn;

      this.logger.debug(`Successfully created TargetGroup ${logicalId}: ${tgArn}`);

      // TargetGroupAttributes and Targets ride on separate post-create calls
      // (ModifyTargetGroupAttributes / RegisterTargets). CreateTargetGroup has
      // already committed the TG, so a failure here would strand it outside
      // cdkd state and the next deploy's CREATE would collide on the unique TG
      // name — wrap in the same best-effort-delete-then-rethrow pattern as the
      // LoadBalancer create path above.
      try {
        const tgAttributes = this.normalizeAttributes(properties['TargetGroupAttributes']);
        if (tgAttributes.length > 0) {
          await this.getClient().send(
            new ModifyTargetGroupAttributesCommand({
              TargetGroupArn: tgArn,
              Attributes: tgAttributes,
            })
          );
          this.logger.debug(
            `Applied ${tgAttributes.length} TargetGroup attribute(s) for ${logicalId}`
          );
        }

        const targets = this.convertTargets(properties['Targets']);
        if (targets.length > 0) {
          await this.getClient().send(
            new RegisterTargetsCommand({ TargetGroupArn: tgArn, Targets: targets })
          );
          this.logger.debug(`Registered ${targets.length} target(s) for ${logicalId}`);
        }
      } catch (innerError) {
        try {
          await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn }));
          this.logger.debug(
            `Cleaned up partially-created TargetGroup ${logicalId} (${tgArn}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created TargetGroup ${logicalId} (${tgArn}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws elbv2 delete-target-group --target-group-arn ${tgArn}`
          );
        }
        throw innerError;
      }

      return {
        physicalId: tgArn,
        attributes: {
          TargetGroupArn: tgArn,
          TargetGroupFullName: tgArn.split(':').pop()?.replace('targetgroup/', ''),
          TargetGroupName: tg.TargetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating TargetGroup ${logicalId}: ${physicalId}`);

    // IpAddressType is createOnly in the CFn schema (the registry fallback
    // already classifies its change as replacement); TargetControlPort has
    // NO modify API at all AND is missing from the schema's
    // createOnlyProperties, so without this guard a change would be silently
    // dropped. Reject both with ResourceUpdateNotSupportedError — the deploy
    // engine matches it by class and falls back to replacement.
    // TargetControlPort is compared numerically ("8080" vs 8080 is a template
    // quoting difference, not a change); IpAddressType compares as a string.
    const immutableChanged = (key: string, coerce: boolean): boolean => {
      const next = properties[key];
      const prev = previousProperties[key];
      if (coerce) {
        const nextNum = next !== undefined ? Number(next) : undefined;
        const prevNum = prev !== undefined ? Number(prev) : undefined;
        return nextNum !== prevNum;
      }
      return JSON.stringify(next) !== JSON.stringify(prev);
    };
    for (const [immutableKey, coerce] of [
      ['IpAddressType', false],
      ['TargetControlPort', true],
    ] as Array<[string, boolean]>) {
      if (immutableChanged(immutableKey, coerce)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `ELBv2 TargetGroup ${immutableKey} is immutable on AWS — no Modify* API accepts it; it is fixed at creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    try {
      // Class 2 sanitize at the wire layer: `readCurrentState` always-emits
      // `Matcher: {}` for non-HTTP/HTTPS target groups (TCP / UDP / GENEVE
      // never carry HttpCode / GrpcCode). Without this guard, `cdkd drift
      // --revert` round-trips the `{}` placeholder back through
      // `ModifyTargetGroup`, which AWS rejects: "Matcher must contain
      // either HttpCode or GrpcCode". Treat the empty object the same as
      // an absent Matcher — drop the key from the API input.
      const rawMatcher = properties['Matcher'] as
        | { HttpCode?: string; GrpcCode?: string }
        | undefined;
      const matcher =
        rawMatcher && (rawMatcher.HttpCode !== undefined || rawMatcher.GrpcCode !== undefined)
          ? rawMatcher
          : undefined;

      // Removal semantics (issue #1160, live CFn A/B 2026-08-10 on an HTTP
      // target group): CloudFormation itself RETAINS every health-check
      // field EXCEPT `HealthCheckPort` when the property is removed from
      // the template — HealthCheckProtocol / HealthCheckPath /
      // HealthCheckEnabled / HealthCheckIntervalSeconds /
      // HealthCheckTimeoutSeconds / HealthyThresholdCount /
      // UnhealthyThresholdCount and the listener's SslPolicy all kept their
      // customized values through a CFn removal update, so cdkd's
      // pass-through (absent -> undefined -> ModifyTargetGroup merge) is
      // already CFn parity for those. `HealthCheckPort` is the one field
      // CFn resets, to its create default `traffic-port`; mirror that.
      // GENEVE target groups are deferred (retain, no reset): their create
      // default is port 80, not `traffic-port`, and CFn's removal behavior
      // for a Gateway Load Balancer TG has not been A/B-verified.
      const targetGroupProtocol = String(
        properties['Protocol'] ?? previousProperties['Protocol'] ?? ''
      ).toUpperCase();
      const healthCheckPort =
        targetGroupProtocol === 'GENEVE'
          ? (properties['HealthCheckPort'] as string | undefined)
          : clearOnUpdateRemoval(
              properties['HealthCheckPort'] as string | undefined,
              previousProperties['HealthCheckPort'] as string | undefined,
              'traffic-port'
            );

      await this.getClient().send(
        new ModifyTargetGroupCommand({
          TargetGroupArn: physicalId,
          HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
          HealthCheckPort: healthCheckPort,
          HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
          HealthCheckEnabled:
            properties['HealthCheckEnabled'] !== undefined
              ? Boolean(properties['HealthCheckEnabled'])
              : undefined,
          HealthCheckIntervalSeconds:
            properties['HealthCheckIntervalSeconds'] !== undefined
              ? Number(properties['HealthCheckIntervalSeconds'])
              : undefined,
          HealthCheckTimeoutSeconds:
            properties['HealthCheckTimeoutSeconds'] !== undefined
              ? Number(properties['HealthCheckTimeoutSeconds'])
              : undefined,
          HealthyThresholdCount:
            properties['HealthyThresholdCount'] !== undefined
              ? Number(properties['HealthyThresholdCount'])
              : undefined,
          UnhealthyThresholdCount:
            properties['UnhealthyThresholdCount'] !== undefined
              ? Number(properties['UnhealthyThresholdCount'])
              : undefined,
          ...(matcher && { Matcher: matcher }),
        })
      );

      // ─── TargetGroupAttributes ───────────────────────────────────────
      // ModifyTargetGroupAttributes replaces ONLY the listed attrs — same
      // key-diff semantics as LoadBalancerAttributes, EXCEPT the removal
      // arm: this API rejects an empty Value ("A target group attribute
      // value must be specified", live-verified 2026-08-11), so a removed
      // key is reset by sending its documented default from
      // TARGET_GROUP_ATTRIBUTE_DEFAULTS; a key with no known default warns
      // and retains the live value. Skip the call when nothing changed.
      const tgAttrDiff = this.diffAttributes(
        this.normalizeAttributes(properties['TargetGroupAttributes']),
        this.normalizeAttributes(previousProperties['TargetGroupAttributes']),
        (key) => {
          const fallback = TARGET_GROUP_ATTRIBUTE_DEFAULTS[key];
          if (fallback === undefined) {
            this.logger.warn(
              `TargetGroup attribute ${key} was removed from the template but has no documented default cdkd can reset it to — the live value is retained. Set the attribute explicitly to change it.`
            );
          }
          return fallback;
        }
      );
      if (tgAttrDiff.length > 0) {
        await this.getClient().send(
          new ModifyTargetGroupAttributesCommand({
            TargetGroupArn: physicalId,
            Attributes: tgAttrDiff,
          })
        );
        this.logger.debug(
          `Applied ${tgAttrDiff.length} TargetGroupAttributes change(s) for ${logicalId}`
        );
      }

      // ─── Targets ─────────────────────────────────────────────────────
      // RegisterTargets / DeregisterTargets diff keyed on the full
      // (Id, Port, AvailabilityZone) tuple — a changed Port registers the new
      // tuple and deregisters the old one. Register first so a target whose
      // spelling changed never has a window with zero registrations.
      const newTargets = this.convertTargets(properties['Targets']);
      const oldTargets = this.convertTargets(previousProperties['Targets']);
      const targetKey = (t: TargetDescription) =>
        JSON.stringify([t.Id, t.Port ?? null, t.AvailabilityZone ?? null]);
      const oldTargetKeys = new Set(oldTargets.map(targetKey));
      const newTargetKeys = new Set(newTargets.map(targetKey));
      const targetsToRegister = newTargets.filter((t) => !oldTargetKeys.has(targetKey(t)));
      const targetsToDeregister = oldTargets.filter((t) => !newTargetKeys.has(targetKey(t)));
      if (targetsToRegister.length > 0) {
        await this.getClient().send(
          new RegisterTargetsCommand({ TargetGroupArn: physicalId, Targets: targetsToRegister })
        );
        this.logger.debug(`Registered ${targetsToRegister.length} target(s) for ${logicalId}`);
      }
      if (targetsToDeregister.length > 0) {
        await this.getClient().send(
          new DeregisterTargetsCommand({
            TargetGroupArn: physicalId,
            Targets: targetsToDeregister,
          })
        );
        this.logger.debug(`Deregistered ${targetsToDeregister.length} target(s) for ${logicalId}`);
      }

      // Describe to get current attributes
      const describeResponse = await this.getClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
      );
      const tg = describeResponse.TargetGroups?.[0];

      // Apply tag diff. ELBv2 uses AddTags / RemoveTags with [arn].
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      this.logger.debug(`Successfully updated TargetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          TargetGroupArn: physicalId,
          TargetGroupFullName: physicalId.split(':').pop()?.replace('targetgroup/', ''),
          TargetGroupName: tg?.TargetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting TargetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: physicalId }));
      this.logger.debug(`Successfully deleted TargetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`TargetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::Listener ─────────────────────────

  private async createListener(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Listener ${logicalId}`);

    try {
      const tags = this.extractTags(properties);
      const defaultActions = this.convertActions(
        properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
      );
      const certificates = this.convertCertificates(
        properties['Certificates'] as Array<Record<string, unknown>> | undefined
      );

      const alpnPolicy = properties['AlpnPolicy'] as string[] | undefined;
      const mutualAuth = properties['MutualAuthentication'] as
        | MutualAuthenticationAttributes
        | undefined;

      const response = await this.getClient().send(
        new CreateListenerCommand({
          LoadBalancerArn: properties['LoadBalancerArn'] as string,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          SslPolicy: properties['SslPolicy'] as string | undefined,
          DefaultActions: defaultActions ?? [],
          ...(certificates && { Certificates: certificates }),
          ...(alpnPolicy && alpnPolicy.length > 0 && { AlpnPolicy: alpnPolicy }),
          ...(mutualAuth !== undefined && { MutualAuthentication: mutualAuth }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const listener = response.Listeners?.[0];
      if (!listener || !listener.ListenerArn) {
        throw new Error('CreateListener did not return Listener ARN');
      }
      const listenerArn = listener.ListenerArn;

      this.logger.debug(`Successfully created Listener ${logicalId}: ${listenerArn}`);

      // CreateListener does NOT accept ListenerAttributes (e.g.
      // `tcp.idle_timeout.seconds`, `routing.http.response.server.enabled`) —
      // they ride on a separate post-create `ModifyListenerAttributes`
      // control-plane call. CreateListener has already committed the listener
      // on AWS, so a failure here would strand a half-configured listener (the
      // throw aborts before the success-return, cdkd state is NOT written, and
      // the next deploy plans CREATE again — but the LB already has a listener
      // on this port, which AWS rejects with `DuplicateListener`). Wrap the
      // attributes call in an inner try/catch that issues a best-effort
      // `DeleteListener` before re-throwing the original error (atomicity),
      // mirroring the LoadBalancer create path above.
      try {
        const listenerAttributes = this.normalizeAttributes(properties['ListenerAttributes']);
        if (listenerAttributes.length > 0) {
          await withRetry(
            () =>
              this.getClient().send(
                new ModifyListenerAttributesCommand({
                  ListenerArn: listenerArn,
                  Attributes: listenerAttributes,
                })
              ),
            logicalId,
            { logger: this.logger }
          );
          this.logger.debug(
            `Applied ${listenerAttributes.length} ListenerAttribute(s) for ${logicalId}`
          );
        }
      } catch (innerError) {
        try {
          await this.getClient().send(new DeleteListenerCommand({ ListenerArn: listenerArn }));
          this.logger.debug(
            `Cleaned up partially-created Listener ${logicalId} (${listenerArn}) after attributes-wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created Listener ${logicalId} (${listenerArn}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws elbv2 delete-listener --listener-arn ${listenerArn}`
          );
        }
        throw innerError;
      }

      return {
        physicalId: listenerArn,
        attributes: {
          ListenerArn: listenerArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Listener ${logicalId}: ${physicalId}`);

    try {
      const defaultActions = this.convertActions(
        properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
      );
      const certificates = this.convertCertificates(
        properties['Certificates'] as Array<Record<string, unknown>> | undefined
      );

      const alpnPolicy = properties['AlpnPolicy'] as string[] | undefined;
      const mutualAuth = properties['MutualAuthentication'] as
        | MutualAuthenticationAttributes
        | undefined;

      await this.getClient().send(
        new ModifyListenerCommand({
          ListenerArn: physicalId,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          SslPolicy: properties['SslPolicy'] as string | undefined,
          ...(defaultActions && { DefaultActions: defaultActions }),
          ...(certificates && { Certificates: certificates }),
          // AlpnPolicy is a TLS-listener-only field; only forward it
          // when the diff actually carries values (CFn template-side it
          // is an array of one entry). An empty array would be rejected
          // by AWS on non-TLS listeners.
          ...(alpnPolicy && alpnPolicy.length > 0 && { AlpnPolicy: alpnPolicy }),
          // MutualAuthentication is HTTPS-listener-only. Forward when
          // the user templated it; AWS will reject on non-HTTPS.
          ...(mutualAuth !== undefined && { MutualAuthentication: mutualAuth }),
        })
      );

      // ─── ListenerAttributes ──────────────────────────────────────────
      // ModifyListenerAttributes replaces ONLY the listed attrs — keys not
      // in the request are left untouched. Build the diff: changed values
      // from newAttrs win; keys present only in oldAttrs are reset. A removed
      // BOOLEAN / ENUM key takes its documented default from
      // LISTENER_ATTRIBUTE_DEFAULTS because this API rejects an empty Value
      // for those — dropping `routing.http.response.server.enabled` failed
      // the whole deploy pre-fix (live-verified 2026-08-11, issue #1609
      // item 1); every other key keeps the empty string, which the API
      // accepts as "clear the override". Skip the call entirely when nothing
      // changed so the no-drift round-trip is a clean no-op. A failure here
      // THROWS (caught by the outer try/catch and re-wrapped as a
      // ProvisioningError) so cdkd state is not written as-if-applied — the
      // next deploy retries.
      const submittedAttrs = this.diffAttributes(
        this.normalizeAttributes(properties['ListenerAttributes']),
        this.normalizeAttributes(previousProperties['ListenerAttributes']),
        (key) => LISTENER_ATTRIBUTE_DEFAULTS[key] ?? ''
      );
      if (submittedAttrs.length > 0) {
        await withRetry(
          () =>
            this.getClient().send(
              new ModifyListenerAttributesCommand({
                ListenerArn: physicalId,
                Attributes: submittedAttrs,
              })
            ),
          logicalId,
          { logger: this.logger }
        );
        this.logger.debug(
          `Applied ${submittedAttrs.length} ListenerAttributes change(s) for ${logicalId}`
        );
      }

      // Apply tag diff. Listener `handledProperties` doesn't currently
      // include Tags but AWS allows tags on listeners; previous state may
      // hold them after import / drift refresh, so handle the diff for
      // safety.
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      this.logger.debug(`Successfully updated Listener ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          ListenerArn: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Listener ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteListenerCommand({ ListenerArn: physicalId }));
      this.logger.debug(`Successfully deleted Listener ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Listener ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Extract Tags from CDK properties
   * CDK format: Array<{Key: string, Value: string}> — same as ELBv2 API format
   */
  private extractTags(properties: Record<string, unknown>): Tag[] {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Tag[];
  }

  /**
   * Normalize a CFn `ListenerAttributes` value (an array of `{ Key, Value }`
   * objects) into the SDK's `Attributes` shape. CFn emits the `Value` as a
   * string (e.g. `"3600"`, `"false"`) — pass it through verbatim; the
   * `ModifyListenerAttributes` API takes string Key/Value pairs. Entries
   * missing a `Key` are dropped (an empty `Value` is a valid "clear the
   * override" signal, so only `Key` is required). Returns `[]` for an
   * absent / non-array value so callers can branch on `.length`.
   *
   * Values are coerced only from `string` / `number` / `boolean` — never
   * `String()`-coerced from an arbitrary object (which would yield
   * `[object Object]`); CFn emits these as strings already, so a non-scalar
   * value is malformed input and is dropped rather than silently stringified.
   */
  private normalizeAttributes(raw: unknown): Array<{ Key: string; Value: string }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ Key: string; Value: string }> = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as { Key?: unknown; Value?: unknown };
      if (typeof e.Key !== 'string') continue;
      let value: string;
      if (e.Value === undefined || e.Value === null) {
        value = '';
      } else if (
        typeof e.Value === 'string' ||
        typeof e.Value === 'number' ||
        typeof e.Value === 'boolean'
      ) {
        value = String(e.Value);
      } else {
        // Non-scalar value — malformed; skip rather than emit [object Object].
        continue;
      }
      out.push({ Key: e.Key, Value: value });
    }
    return out;
  }

  /**
   * Key-diff two normalized `{Key, Value}` attribute lists into the payload
   * for a Modify*Attributes call: changed values from `newAttrs` win, and
   * keys present only in `oldAttrs` are pushed back through `removalValue`.
   * A resolver returning `undefined` SKIPS the entry (the resolver owns any
   * warn). An empty return means nothing changed and the call should be
   * skipped. Shared by the LoadBalancer / TargetGroup / Listener update
   * paths — and all three pass their OWN resolver, because the three APIs
   * disagree about what resets an attribute:
   *
   * - LoadBalancer / Listener: the empty string clears a numeric or
   *   free-form-string override, but a BOOLEAN / ENUM key rejects it and
   *   fails the whole call, so those take a documented default
   *   (`LOAD_BALANCER_ATTRIBUTE_DEFAULTS` / `LISTENER_ATTRIBUTE_DEFAULTS`).
   * - TargetGroup: the empty string is rejected for EVERY key, so the
   *   documented default is the only reset and an unknown key warns and
   *   retains (`TARGET_GROUP_ATTRIBUTE_DEFAULTS`).
   *
   * All three behaviours were live-verified 2026-08-11; the default
   * parameter is retained only for callers that genuinely want the plain
   * empty-string reset.
   */
  private diffAttributes(
    newAttrs: Array<{ Key: string; Value: string }>,
    oldAttrs: Array<{ Key: string; Value: string }>,
    removalValue: (key: string) => string | undefined = () => ''
  ): Array<{ Key: string; Value: string }> {
    const newAttrMap = new Map(newAttrs.map((a) => [a.Key, a.Value]));
    const oldAttrMap = new Map(oldAttrs.map((a) => [a.Key, a.Value]));
    const submitted: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newAttrMap) {
      if (oldAttrMap.get(k) !== v) submitted.push({ Key: k, Value: v });
    }
    for (const [k] of oldAttrMap) {
      if (!newAttrMap.has(k)) {
        const value = removalValue(k);
        if (value !== undefined) submitted.push({ Key: k, Value: value });
      }
    }
    return submitted;
  }

  /**
   * Normalize a CFn `Targets` value (an array of `{ Id, Port?,
   * AvailabilityZone? }` objects) into the SDK's `TargetDescription[]` shape.
   * Entries missing an `Id` are dropped (Id is the only required member);
   * `Port` is numeric-coerced (CFn templates may carry it as a string).
   * Returns `[]` for an absent / non-array value so callers can branch on
   * `.length`.
   */
  private convertTargets(raw: unknown): TargetDescription[] {
    if (!Array.isArray(raw)) return [];
    const out: TargetDescription[] = [];
    for (const entry of raw) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof (entry as CfnTargetDescription).Id !== 'string' ||
        ((entry as CfnTargetDescription).Id as string).length === 0
      ) {
        this.logger.warn(
          `Dropping malformed TargetGroup Targets entry (missing string Id): ${JSON.stringify(entry)}`
        );
        continue;
      }
      const e = entry as CfnTargetDescription;
      out.push({
        Id: e.Id as string,
        ...(e.Port !== undefined && { Port: Number(e.Port) }),
        ...(e.AvailabilityZone !== undefined && { AvailabilityZone: e.AvailabilityZone }),
      });
    }
    return out;
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via ELBv2's
   * `AddTags` / `RemoveTags` APIs. Both accept `ResourceArns: [arn]`
   * (single ARN), `Tags: [{Key, Value}]` for AddTags, and
   * `TagKeys: [...]` for RemoveTags.
   */
  private async applyTagDiff(
    arn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Tag[] = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsCommand({ ResourceArns: [arn], TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from ELBv2 resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(new AddTagsCommand({ ResourceArns: [arn], Tags: tagsToAdd }));
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on ELBv2 resource ${arn}`);
    }
  }

  /**
   * Convert CDK DefaultActions to ELBv2 API Action format
   * CDK uses PascalCase property names matching the ELBv2 API, so pass through.
   */
  private convertActions(
    actions: Array<Record<string, unknown>> | undefined
  ): Action[] | undefined {
    if (!actions || actions.length === 0) return undefined;
    return actions as unknown as Action[];
  }

  /**
   * Convert CDK Certificates to ELBv2 API Certificate format
   */
  private convertCertificates(
    certificates: Array<Record<string, unknown>> | undefined
  ): Certificate[] | undefined {
    if (!certificates || certificates.length === 0) return undefined;
    return certificates as unknown as Certificate[];
  }

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
   * when AWS reports no user tags. Returns `undefined` when the resource
   * is gone (`*NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
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

  private async readLoadBalancer(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let lb;
    try {
      const resp = await this.getClient().send(
        new DescribeLoadBalancersCommand({ LoadBalancerArns: [physicalId] })
      );
      lb = resp.LoadBalancers?.[0];
    } catch (err) {
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
    if (!lb) return undefined;

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
    // the same full set at deploy time). On the v2 fallback baseline
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
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    await this.attachTags(result, physicalId);
    return result;
  }

  private async readTargetGroup(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let tg;
    try {
      const resp = await this.getClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
      );
      tg = resp.TargetGroups?.[0];
    } catch (err) {
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
    if (!tg) return undefined;

    const result: Record<string, unknown> = {};
    if (tg.TargetGroupName !== undefined) result['Name'] = tg.TargetGroupName;
    if (tg.Protocol !== undefined) result['Protocol'] = tg.Protocol;
    if (tg.Port !== undefined) result['Port'] = tg.Port;
    if (tg.VpcId !== undefined) result['VpcId'] = tg.VpcId;
    if (tg.TargetType !== undefined) result['TargetType'] = tg.TargetType;
    if (tg.ProtocolVersion !== undefined) result['ProtocolVersion'] = tg.ProtocolVersion;
    if (tg.HealthCheckProtocol !== undefined)
      result['HealthCheckProtocol'] = tg.HealthCheckProtocol;
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
    // ListenerAttributes. Targets are deliberately NOT read back — see
    // getDriftUnknownPaths.
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
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    await this.attachTags(result, physicalId);
    return result;
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        // EnableCapacityReservationProvisionStabilize is a CFn-only
        // orchestration flag (wait-for-provisioned opt-in) with no AWS-side
        // readback — it is not a resource property on the wire.
        return ['EnableCapacityReservationProvisionStabilize'];
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        // Targets ARE readable via DescribeTargetHealth, but the readback is
        // an unordered object list (the drift comparator is positional and
        // drift-normalize only canonicalizes tag lists / plain-string id
        // arrays) and deregistration is asynchronous (a just-removed target
        // reports `draining` for minutes) — both would fire phantom drift on
        // every template whose order differs from AWS's. Declared unknown
        // until object-array unordered comparison exists.
        return ['Targets'];
      default:
        return [];
    }
  }

  private async readListener(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let listener;
    try {
      const resp = await this.getClient().send(
        new DescribeListenersCommand({ ListenerArns: [physicalId] })
      );
      listener = resp.Listeners?.[0];
    } catch (err) {
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }
    if (!listener) return undefined;

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
      if (this.isNotFoundError(err)) return undefined;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

    await this.attachTags(result, physicalId);
    return result;
  }

  /** Best-effort tag fetch via `DescribeTags(ResourceArns=[arn])`. */
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const resp = await this.getClient().send(new DescribeTagsCommand({ ResourceArns: [arn] }));
      const tagDesc = resp.TagDescriptions?.[0];
      const tags = normalizeAwsTagsToCfn(tagDesc?.Tags);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `ELBv2 DescribeTags(${arn}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Adopt an existing ELBv2 LoadBalancer or TargetGroup into cdkd state.
   *
   * Lookup: `--resource <id>=<arn>` override → verify with
   * `DescribeLoadBalancers` or `DescribeTargetGroups`. Without an override
   * the resource is reported as not-found.
   *
   * Listener is likewise not auto-importable (no template-supplied stable
   * identifier); use `--resource <listenerId>=<arn>` for those.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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

  private async importLoadBalancer(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeLoadBalancersCommand({ LoadBalancerArns: [input.knownPhysicalId] })
        );
        return resp.LoadBalancers?.[0]?.LoadBalancerArn
          ? { physicalId: resp.LoadBalancers[0].LoadBalancerArn, attributes: {} }
          : null;
      } catch (err) {
        if (this.isNotFoundError(err)) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // load balancer reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importTargetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeTargetGroupsCommand({ TargetGroupArns: [input.knownPhysicalId] })
        );
        return resp.TargetGroups?.[0]?.TargetGroupArn
          ? { physicalId: resp.TargetGroups[0].TargetGroupArn, attributes: {} }
          : null;
      } catch (err) {
        if (this.isNotFoundError(err)) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // target group reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Check if an error indicates the resource was not found
   */
  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = (error.message || '').toLowerCase();
    const name = (error as { name?: string }).name ?? '';
    return (
      message.includes('not found') ||
      message.includes('does not exist') ||
      name === 'LoadBalancerNotFoundException' ||
      name === 'TargetGroupNotFoundException' ||
      name === 'ListenerNotFoundException'
    );
  }
}
