import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancersCommand,
  DescribeLoadBalancerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
  SetSubnetsCommand,
  SetSecurityGroupsCommand,
  SetIpAddressTypeCommand,
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  ModifyTargetGroupCommand,
  DescribeTargetGroupsCommand,
  DescribeTagsCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  CreateListenerCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  DescribeListenersCommand,
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
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
 * that polling and returns instantly.
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
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const lb = response.LoadBalancers?.[0];
      if (!lb || !lb.LoadBalancerArn) {
        throw new Error('CreateLoadBalancer did not return LoadBalancer ARN');
      }

      this.logger.debug(`Successfully created LoadBalancer ${logicalId}: ${lb.LoadBalancerArn}`);

      // Apply LoadBalancerAttributes if specified
      const lbAttributes = properties['LoadBalancerAttributes'] as
        | Array<{ Key: string; Value: string }>
        | undefined;
      if (lbAttributes && lbAttributes.length > 0) {
        await this.getClient().send(
          new ModifyLoadBalancerAttributesCommand({
            LoadBalancerArn: lb.LoadBalancerArn,
            Attributes: lbAttributes.map((attr) => ({
              Key: attr.Key,
              Value: attr.Value,
            })),
          })
        );
        this.logger.debug(
          `Applied ${lbAttributes.length} LoadBalancer attributes for ${logicalId}`
        );
      }

      return {
        physicalId: lb.LoadBalancerArn,
        attributes: {
          DNSName: lb.DNSName,
          CanonicalHostedZoneID: lb.CanonicalHostedZoneId,
          LoadBalancerArn: lb.LoadBalancerArn,
          LoadBalancerFullName: lb.LoadBalancerArn?.split('/').slice(1).join('/'),
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
    //   - Subnets / SubnetMappings → SetSubnets (full replace)
    //   - SecurityGroups → SetSecurityGroups (full replace)
    //   - IpAddressType → SetIpAddressType
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
        'ELBv2 LoadBalancer in-place updates are supported for LoadBalancerAttributes / Subnets / SubnetMappings / SecurityGroups / IpAddressType / Tags only; for Name / Type / Scheme, re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
      );
    }

    // ─── LoadBalancerAttributes ──────────────────────────────────────
    // ModifyLoadBalancerAttributes replaces ONLY the listed attrs — keys
    // not in the request are left untouched. Build the diff: changed
    // values from newAttrs win; keys present only in oldAttrs are
    // pushed back to AWS's documented default (the empty string),
    // which clears the override. Skip the call entirely when nothing
    // changed so the no-drift round-trip is a clean no-op.
    const newAttrs =
      (properties['LoadBalancerAttributes'] as Array<{ Key: string; Value: string }> | undefined) ??
      [];
    const oldAttrs =
      (previousProperties['LoadBalancerAttributes'] as
        | Array<{ Key: string; Value: string }>
        | undefined) ?? [];
    const newAttrMap = new Map(newAttrs.map((a) => [a.Key, a.Value]));
    const oldAttrMap = new Map(oldAttrs.map((a) => [a.Key, a.Value]));
    const submittedAttrs: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newAttrMap) {
      if (oldAttrMap.get(k) !== v) submittedAttrs.push({ Key: k, Value: v });
    }
    for (const [k] of oldAttrMap) {
      if (!newAttrMap.has(k)) submittedAttrs.push({ Key: k, Value: '' });
    }
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
    const subnetsChanged = JSON.stringify(newSubnets) !== JSON.stringify(oldSubnets);
    const mappingsChanged = JSON.stringify(newMappings) !== JSON.stringify(oldMappings);
    if (subnetsChanged || mappingsChanged) {
      await this.getClient().send(
        new SetSubnetsCommand({
          LoadBalancerArn: physicalId,
          ...(newMappings && newMappings.length > 0
            ? { SubnetMappings: newMappings }
            : { Subnets: newSubnets }),
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
    if (JSON.stringify(newSGs) !== JSON.stringify(oldSGs)) {
      await this.getClient().send(
        new SetSecurityGroupsCommand({
          LoadBalancerArn: physicalId,
          SecurityGroups: newSGs ?? [],
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

    // ─── Tags ────────────────────────────────────────────────────────
    await this.applyTagDiff(
      physicalId,
      previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
      properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
    );

    return { physicalId, wasReplaced: false };
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
          ...(matcher && { Matcher: matcher }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const tg = response.TargetGroups?.[0];
      if (!tg || !tg.TargetGroupArn) {
        throw new Error('CreateTargetGroup did not return TargetGroup ARN');
      }

      this.logger.debug(`Successfully created TargetGroup ${logicalId}: ${tg.TargetGroupArn}`);

      return {
        physicalId: tg.TargetGroupArn,
        attributes: {
          TargetGroupArn: tg.TargetGroupArn,
          TargetGroupFullName: tg.TargetGroupArn?.split(':').pop()?.replace('targetgroup/', ''),
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

      await this.getClient().send(
        new ModifyTargetGroupCommand({
          TargetGroupArn: physicalId,
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
          ...(matcher && { Matcher: matcher }),
        })
      );

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

      this.logger.debug(`Successfully created Listener ${logicalId}: ${listener.ListenerArn}`);

      return {
        physicalId: listener.ListenerArn,
        attributes: {
          ListenerArn: listener.ListenerArn,
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
    const matcher: Record<string, unknown> = {};
    if (tg.Matcher?.HttpCode !== undefined) matcher['HttpCode'] = tg.Matcher.HttpCode;
    if (tg.Matcher?.GrpcCode !== undefined) matcher['GrpcCode'] = tg.Matcher.GrpcCode;
    result['Matcher'] = matcher;
    await this.attachTags(result, physicalId);
    return result;
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
   * Lookup order:
   *  1. `--resource <id>=<arn>` override → verify with `DescribeLoadBalancers`
   *     or `DescribeTargetGroups`.
   *  2. Walk `DescribeLoadBalancers` / `DescribeTargetGroups` paginators →
   *     batch-fetch tags for each ARN with `DescribeTags(ResourceArns)`
   *     and match `aws:cdk:path` (standard `Key`/`Value` Tag[] shape).
   *
   * Listener is not auto-importable (no template-supplied stable
   * identifier and no convenient tag-by-LB-context shortcut); use
   * `--resource <listenerId>=<arn>` for those.
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

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeLoadBalancersCommand({ ...(marker && { Marker: marker }) })
      );
      const arns = (list.LoadBalancers ?? [])
        .map((lb) => lb.LoadBalancerArn)
        .filter((arn): arn is string => Boolean(arn));
      // DescribeTags accepts up to 20 ARNs per call.
      for (let i = 0; i < arns.length; i += 20) {
        const batch = arns.slice(i, i + 20);
        const tagsResp = await this.getClient().send(
          new DescribeTagsCommand({ ResourceArns: batch })
        );
        for (const td of tagsResp.TagDescriptions ?? []) {
          if (td.ResourceArn && matchesCdkPath(td.Tags, input.cdkPath)) {
            return { physicalId: td.ResourceArn, attributes: {} };
          }
        }
      }
      marker = list.NextMarker;
    } while (marker);
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

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeTargetGroupsCommand({ ...(marker && { Marker: marker }) })
      );
      const arns = (list.TargetGroups ?? [])
        .map((tg) => tg.TargetGroupArn)
        .filter((arn): arn is string => Boolean(arn));
      for (let i = 0; i < arns.length; i += 20) {
        const batch = arns.slice(i, i + 20);
        const tagsResp = await this.getClient().send(
          new DescribeTagsCommand({ ResourceArns: batch })
        );
        for (const td of tagsResp.TagDescriptions ?? []) {
          if (td.ResourceArn && matchesCdkPath(td.Tags, input.cdkPath)) {
            return { physicalId: td.ResourceArn, attributes: {} };
          }
        }
      }
      marker = list.NextMarker;
    } while (marker);
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
