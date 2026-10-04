import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { isSettledInstanceState } from '../../provisioning/ec2-instance-state.js';
import type { ResourceState } from '../../types/state.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import {
  type ResolverContext,
  cachedCloudFrontDomainNames,
  cachedEc2InstanceAttributes,
  cachedSecurityGroupVpcIds,
  quotedRender,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import { StaleAttributeMissSignal } from '../stale-attribute-heal.js';
import { GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import {
  DescribeInstancesCommand,
  DescribeLaunchTemplatesCommand,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import { NOT_CONSTRUCTED } from './getatt-construct-core.js';

/**
 * `constructAttribute`'s per-type handlers for AWS::Logs::LogGroup through AWS::RDS::DBProxy, moved
 * verbatim and in order (issue #4337). Returns {@link NOT_CONSTRUCTED} when none
 * matched. Keep the `constructAttributeFor*` name and the `getatt-construct-*.ts`
 * file name: `scripts/gen-sdk-attr-coverage.ts` finds handled types by both.
 */
export async function constructAttributeForComputeTypes(
  this: IntrinsicFunctionResolver,
  attributeName: string,
  context: ResolverContext,
  logicalId: string,
  resourceType: ResourceState['resourceType'],
  physicalId: ResourceState['physicalId'],
  accountId: string,
  partition: string,
  region: string
): Promise<unknown> {
  // CloudWatch Logs Log Group
  if (resourceType === 'AWS::Logs::LogGroup') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:logs:${region}:${accountId}:log-group:${physicalId}:*`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ECR Repository
  if (resourceType === 'AWS::ECR::Repository') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:ecr:${region}:${accountId}:repository/${physicalId}`;
      case 'RepositoryUri':
        // The URL SUFFIX is derived for the same reason the partition is
        // (issue #1730 review): an ECR registry host is
        // `<acct>.dkr.ecr.<region>.amazonaws.com.cn` in `aws-cn`, so a
        // hardcoded `amazonaws.com` is the identical defect one field over —
        // and this is the very attribute whose account embedding the
        // unknown-account guard matches by bare substring for.
        return `${accountId}.dkr.ecr.${region}.${derivePartitionAndUrlSuffix(region).urlSuffix}/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ECS Cluster
  if (resourceType === 'AWS::ECS::Cluster') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:ecs:${region}:${accountId}:cluster/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ECS Service — derive `Name` from the service ARN. The provider stores
  // the service ARN as the physical id (with an optional composite
  // `|<suffix>` used by some internal paths — readCurrentState's
  // `<clusterArn>|<serviceName>` form, and a `<serviceArn>|<clusterName>`
  // shape that has been observed at deploy time). Both shapes are
  // disambiguated by checking the LHS for `:service/`:
  //   - LHS is a service ARN (contains `:service/`) → last `/` segment
  //     is the service name (works for plain ARN and `<serviceArn>|x`).
  //   - LHS is a cluster ARN → the RHS after `|` is the service name
  //     (matches the import/readCurrentState `<clusterArn>|<serviceName>`
  //     format).
  if (resourceType === 'AWS::ECS::Service') {
    switch (attributeName) {
      case 'Name': {
        const pipeIdx = physicalId.indexOf('|');
        const left = pipeIdx >= 0 ? physicalId.substring(0, pipeIdx) : physicalId;
        if (left.includes(':service/')) {
          const lastSlash = left.lastIndexOf('/');
          return lastSlash >= 0 ? left.substring(lastSlash + 1) : physicalId;
        }
        if (pipeIdx >= 0) {
          return physicalId.substring(pipeIdx + 1);
        }
        return physicalId;
      }
      case 'ServiceArn': {
        // Documented GetAtt whose correct value IS the physicalId: the SDK
        // provider stores the service ARN as the physical ID, so return it
        // verbatim instead of routing through the guard — on imported /
        // legacy state without cached attributes, --strict-getatt would
        // otherwise reject a CORRECT fallback (review of issue #1111).
        // Compound `<a>|<b>` ids (import / readCurrentState shapes) are
        // disambiguated like `Name` above: the `:service/`-containing side
        // is the service ARN.
        const pipeIdx = physicalId.indexOf('|');
        if (pipeIdx < 0) return physicalId;
        const left = physicalId.substring(0, pipeIdx);
        if (left.includes(':service/')) return left; // <serviceArn>|<clusterName>
        // `<clusterArn>|<serviceName>`: the (new-format, long-ARN) service
        // ARN is `arn:...:service/<clusterName>/<serviceName>`, derivable
        // from the cluster ARN side.
        const clusterIdx = left.indexOf(':cluster/');
        if (clusterIdx < 0) return physicalId;
        const clusterName = left.substring(clusterIdx + ':cluster/'.length);
        const serviceName = physicalId.substring(pipeIdx + 1);
        return `${left.substring(0, clusterIdx)}:service/${clusterName}/${serviceName}`;
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 Security Group
  if (resourceType === 'AWS::EC2::SecurityGroup') {
    switch (attributeName) {
      case 'GroupId':
        return physicalId; // Physical ID is already the group ID (sg-xxx)
      case 'VpcId': {
        // Reached only when the record OMITS the key: `resolveGetAtt`'s flat
        // lookup serves any present value first. `EC2Provider` records
        // `VpcId` from a post-create / post-update `DescribeSecurityGroups`
        // and omits the key when that read failed (issue #3097), so this arm
        // re-reads the same thing the provider could not. It used to answer
        // `undefined` (`// Would need API call`), which `Fn::Join` /
        // `Fn::Sub` render as the literal `'undefined'` — so a group declared
        // without `VpcId` (a hand-written L1 landing in the default VPC)
        // resolved to `''` from the record or `'undefined'` from here, where
        // CloudFormation answers the default VPC's id. A `sg-...` can never
        // satisfy a `vpc-...` slot, so a read that fails or finds nothing
        // REFUSES instead; unmarked, because the read can succeed on a retry.
        // The id is sent as a `GroupIds` member, not a filter, so `*` / `?`
        // carry no wildcard meaning there — the shape guard exists because
        // the id keys the cache below, and EC2 rejects a malformed id with
        // `InvalidGroupId.Malformed` anyway (#3125 pattern). Refused BEFORE
        // the cache read AND the describe, and marked: the verdict is read
        // off the persisted record, which no retry rewrites, and the message
        // interpolates the logical id (#1838).
        if (!/^sg-[0-9a-f]+$/.test(physicalId)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, VpcId] for AWS::EC2::SecurityGroup: the ` +
                `state record's physical id ${quotedRender(this.displayMasked(physicalId, context).slice(0, 64), '"')} ` +
                `is not a security group id (sg-<hex>), so cdkd will not look it up. Repair the ` +
                `record (cdkd import, or re-create the security group) and deploy again.`
            )
          );
        }
        const cachedVpcId = cachedSecurityGroupVpcIds[physicalId];
        if (cachedVpcId !== undefined) return cachedVpcId;
        let vpcId: string | undefined;
        try {
          const ec2 = this.clientsForRegion(this.explicitRegion).ec2;
          const resp = await ec2.send(
            new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
          );
          vpcId = resp.SecurityGroups?.[0]?.VpcId;
        } catch (err) {
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('DescribeSecurityGroups', err, context),
            remedy:
              'Fix the read (the ec2:DescribeSecurityGroups permission, or the region) and deploy again.',
          });
        }
        if (vpcId) {
          cachedSecurityGroupVpcIds[physicalId] = vpcId;
          return vpcId;
        }
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'DescribeSecurityGroups reports no VpcId for the group',
          remedy:
            'Check the security group in the console, or reference the attribute from a later deploy.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 Subnet
  if (resourceType === 'AWS::EC2::Subnet') {
    switch (attributeName) {
      case 'SubnetId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 Instance — IP / DNS / AZ attributes are AWS-assigned at launch and
  // are NOT derivable from the instance id, so they require a live
  // `DescribeInstances` lookup (cached per (physicalId, attribute) for the
  // deploy lifetime). Falling back to the physical id — as the previous
  // default did — handed the instance id to a downstream consumer expecting
  // an IP (e.g. an ELBv2 IP-target group registration, which rejects
  // `i-...` with `not a valid IPv4 address`).
  //
  // Reached only when the record OMITS the attribute: `resolveGetAtt`'s
  // flat lookup serves any stored value first, `''` included. Since issue
  // #3077 `EC2Provider` omits a public member only while the instance is
  // `pending` (a `--no-wait` create) and records a settled instance's
  // missing public address as the known `''` CloudFormation reports.
  if (resourceType === 'AWS::EC2::Instance') {
    switch (attributeName) {
      case 'InstanceId':
        // The physical id IS the instance id — a known-correct fallback,
        // so it must not route through the unknown-attribute guard.
        return physicalId;
      case 'PrivateIp':
      case 'PublicIp':
      case 'PrivateDnsName':
      case 'PublicDnsName':
      case 'AvailabilityZone': {
        const cacheKey = `${physicalId}#${attributeName}`;
        const cached = cachedEc2InstanceAttributes[cacheKey];
        if (cached !== undefined) {
          return cached;
        }
        let value: string | undefined;
        let stateName: string | undefined;
        try {
          // Region-sensitive: an instance id only resolves in its own region,
          // and a foreign-region client answers `InvalidInstanceID.NotFound`,
          // which lands in the catch below (issue #1957).
          const clients = this.clientsForRegion(this.explicitRegion);
          const response = await clients.ec2.send(
            new DescribeInstancesCommand({ InstanceIds: [physicalId] })
          );
          const instance = response.Reservations?.[0]?.Instances?.[0];
          stateName = instance?.State?.Name;
          switch (attributeName) {
            case 'PrivateIp':
              value = instance?.PrivateIpAddress;
              break;
            case 'PublicIp':
              value = instance?.PublicIpAddress;
              break;
            case 'PrivateDnsName':
              value = instance?.PrivateDnsName;
              break;
            case 'PublicDnsName':
              value = instance?.PublicDnsName;
              break;
            case 'AvailabilityZone':
              value = instance?.Placement?.AvailabilityZone;
              break;
          }
        } catch (err) {
          // The instance id is the WRONG value for every one of these
          // attributes, so a failed read is a refusal, not a fallback (issue
          // #3096). Unmarked: the read can succeed on a retry.
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('DescribeInstances', err, context),
            remedy:
              'Fix the read (the ec2:DescribeInstances permission, or the region) and deploy again.',
          });
        }
        if (value !== undefined && value !== null && value !== '') {
          cachedEc2InstanceAttributes[cacheKey] = value;
          return value;
        }
        // The SAME three-state rule `EC2Provider.describedInstanceAttributes`
        // records by (issue #3077), through the ONE shared predicate
        // (`isSettledInstanceState`), applied at resolution time: a SETTLED
        // instance (any reported state but `pending`) with no public address
        // is a private-subnet instance, and CloudFormation answers `''` for
        // `PublicIp` / `PublicDnsName` there. It is a known value, so it is
        // cached like an address. Without this arm a `--no-wait` create in a
        // private subnet — whose record omits the pair and is never rewritten
        // by a no-change deploy — would refuse on every later resolution
        // (the residual that provider's doc comment tracked on #3096).
        const settled = isSettledInstanceState(stateName);
        if (settled && (attributeName === 'PublicIp' || attributeName === 'PublicDnsName')) {
          cachedEc2InstanceAttributes[cacheKey] = '';
          return '';
        }
        // Still `pending` (a `--no-wait` create read moments after launch),
        // or a settled instance with no private address / zone at all (a
        // terminated one, or a describe that returned no instance). Before
        // #3096 this warned `returning physical ID` and handed the instance
        // id to the consumer — an Output or an export carried it silently.
        // Nothing is cached: the next resolution re-describes, when the
        // instance may have settled. Unmarked for the same reason.
        // `stateName` is an EC2 state enum value (`pending` / `running` /
        // ...) from the describe, never a resolved template value.
        const observedState = stateName === undefined ? 'no instance state' : `state ${stateName}`;
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: `DescribeInstances reports no ${this.displayMasked(attributeName, context)} yet (${observedState})`,
          remedy: settled
            ? 'Check the instance in the console; a terminated or stopped instance has no such attribute to serve.'
            : 'Deploy without --no-wait so the instance is running before its attributes are read, or reference the attribute from a later deploy once it is.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 LaunchTemplate — `LatestVersionNumber` / `DefaultVersionNumber`
  // are AWS-derived integers that cdkd does not capture in state.
  // Resolve via `DescribeLaunchTemplates`. Return as a string so
  // downstream consumers (`AWS::AutoScaling::AutoScalingGroup`'s
  // `LaunchTemplate.Version`) get the form AWS accepts. Falling back
  // to the physical ID — as the previous default did — produced
  // `Invalid launch template version: either '$Default', '$Latest',
  // or a numeric version are allowed.` on `CreateAutoScalingGroup`.
  if (resourceType === 'AWS::EC2::LaunchTemplate') {
    if (attributeName === 'LatestVersionNumber' || attributeName === 'DefaultVersionNumber') {
      try {
        // Region-sensitive for the same reason as `DescribeInstances` above:
        // a launch-template id is regional (issue #1957).
        const clients = this.clientsForRegion(this.explicitRegion);
        const response = await clients.ec2.send(
          new DescribeLaunchTemplatesCommand({ LaunchTemplateIds: [physicalId] })
        );
        const lt = response.LaunchTemplates?.[0];
        const value =
          attributeName === 'LatestVersionNumber'
            ? lt?.LatestVersionNumber
            : lt?.DefaultVersionNumber;
        if (value !== undefined && value !== null) {
          return String(value);
        }
      } catch (err) {
        // The id through the builder (issue #3479), as the SDK message
        // beside it already was: a state-record id is not always
        // AWS-assigned (see the VPC `Ipv6CidrBlocks` arm).
        this.logger.warn(
          `DescribeLaunchTemplates(${this.displayMasked(physicalId, context)}) failed for ${this.displayMasked(attributeName, context)}: ${this.displayMasked(err instanceof Error ? err.message : String(err), context)}`
        );
      }
      // Fallback to "$Latest" / "$Default" — both are AWS-accepted
      // strings for the corresponding semantic, and let AWS pick the
      // version at API call time. Better than the resource-id
      // physicalId fallback which AWS rejects.
      return attributeName === 'LatestVersionNumber' ? '$Latest' : '$Default';
    }
    if (attributeName === 'LaunchTemplateId') {
      // The physical id IS the launch template id (lt-...) — a
      // known-correct fallback, so it must not route through the
      // unknown-attribute guard.
      return physicalId;
    }
    return this.guardedPhysicalIdFallback(
      logicalId,
      attributeName,
      resourceType,
      physicalId,
      context
    );
  }

  // CloudFront Distribution — `DomainName` is the AWS-assigned hostname
  // (`d111111abcdef8.cloudfront.net`), recorded by the provider from the
  // create / update response and omitted when that response lacked it
  // (issue #3077). The distribution id can never stand in for a hostname,
  // so the arm re-reads it live rather than falling to
  // `guardedPhysicalIdFallback` (issue #3096). `Id` IS the physical id.
  if (resourceType === 'AWS::CloudFront::Distribution') {
    switch (attributeName) {
      case 'Id':
        return physicalId;
      case 'DomainName': {
        // A distribution id is `E` + 13 upper-case alphanumerics. Refused
        // before the cache read (keyed by this id) and the `GetDistribution`
        // it would parameterise; marked, since the record decides it.
        if (!/^[A-Z0-9]+$/.test(physicalId)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, DomainName] for AWS::CloudFront::Distribution: the ` +
                `state record's physical id ${quotedRender(this.displayMasked(physicalId, context).slice(0, 64), '"')} ` +
                `is not a distribution id (upper-case alphanumerics), so cdkd will not look it up. Repair the ` +
                `record (cdkd import, or re-create the distribution) and deploy again.`
            )
          );
        }
        const cachedDomainName = cachedCloudFrontDomainNames[physicalId];
        if (cachedDomainName !== undefined) return cachedDomainName;
        let domainName: string | undefined;
        try {
          // CloudFront is a global service; `AwsClients.cloudFront` answers
          // for any region, so the ambient / `--region` bag is the right one.
          const cloudFront = this.clientsForRegion(this.explicitRegion).cloudFront;
          const resp = await cloudFront.send(new GetDistributionCommand({ Id: physicalId }));
          domainName = resp.Distribution?.DomainName;
        } catch (err) {
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('GetDistribution', err, context),
            remedy: 'Fix the read (the cloudfront:GetDistribution permission) and deploy again.',
          });
        }
        if (domainName) {
          cachedCloudFrontDomainNames[physicalId] = domainName;
          return domainName;
        }
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'GetDistribution reports no DomainName',
          remedy:
            'Check the distribution in the console, or reference the attribute from a later deploy.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // RDS DBProxy / DBProxyEndpoint — `VpcId` is read from `DescribeDBProxies`
  // / `DescribeDBProxyEndpoints` by the provider and omitted when the
  // response lacked it (issue #3077). The proxy / endpoint NAME can never
  // satisfy a `VpcId` position, and this file has no RDS client to re-read
  // it with (`AwsClients` exposes none), so the arm is a refusal only — a
  // VALUE-TYPED one, decided from the omitted key and the attribute name
  // (issue #3096). Marked non-retryable, unlike the live-read arms above:
  // no retry of this deploy rewrites the state record it is read from, and
  // the message interpolates the logical id (#1838). The next `update()` of
  // the resource records the key.
  if (resourceType === 'AWS::RDS::DBProxy' || resourceType === 'AWS::RDS::DBProxyEndpoint') {
    if (attributeName === 'VpcId') {
      // Issue #1852: the same no-change gap as the shared fallback — "its next
      // deploy records the value" is true only of a deploy that UPDATES the
      // proxy — and both providers' `import()` report `VpcId`, so let the heal
      // wrapper re-read the record before this refuses.
      if (context.staleAttributeHeal?.phase === 'probe') throw new StaleAttributeMissSignal();
      const vpcIdHealOutcome =
        context.staleAttributeHeal?.phase === 'settled'
          ? context.staleAttributeHeal.outcome
          : undefined;
      // not-in-class(resourceType): the enclosing `if` compared it for EQUALITY
      // with two literals, so it carries no control character (issue #3441).
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${resourceType}: ` +
            `the state record holds no VpcId for it (the read-back that would have recorded it reported none), ` +
            `and the physical id ${quotedRender(this.displayMasked(physicalId, context), '"')} is a name, not a VPC id, so cdkd ` +
            `refuses to substitute it. ` +
            `${this.staleRecordRemedy(vpcIdHealOutcome, context)} Referencing the VPC directly also works.`
        )
      );
    }
    return this.guardedPhysicalIdFallback(
      logicalId,
      attributeName,
      resourceType,
      physicalId,
      context
    );
  }
  return NOT_CONSTRUCTED;
}
