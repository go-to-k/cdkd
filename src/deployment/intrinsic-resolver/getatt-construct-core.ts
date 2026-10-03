import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ResourceState } from '../../types/state.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import {
  s3BucketArn,
  s3BucketDomainName,
  s3BucketDualStackDomainName,
  s3BucketRegionalDomainName,
  s3BucketWebsiteUrl,
} from '../../utils/s3-endpoints.js';
import { type ResolverContext, cachedVpcDefaultSecurityGroups, quotedRender } from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import { DescribeSecurityGroupsCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';

/**
 * What a `constructAttribute` helper returns when none of its types matched,
 * so the caller tries the next group and finally the physical-id fallback.
 */
export const NOT_CONSTRUCTED: unique symbol = Symbol('NOT_CONSTRUCTED');

/**
 * `constructAttribute`'s per-type handlers for AWS::DynamoDB::Table through AWS::Kinesis::Stream, moved
 * verbatim and in order (issue #4337). Returns {@link NOT_CONSTRUCTED} when none
 * matched.
 */
export async function constructAttributeForCoreTypes(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  context: ResolverContext,
  logicalId: string,
  resourceType: ResourceState['resourceType'],
  physicalId: ResourceState['physicalId'],
  accountId: string,
  partition: string,
  region: string
): Promise<unknown> {
  // DynamoDB Table / GlobalTable (CDK TableV2 synthesizes as AWS::DynamoDB::GlobalTable; ARN format is identical)
  if (resourceType === 'AWS::DynamoDB::Table' || resourceType === 'AWS::DynamoDB::GlobalTable') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:dynamodb:${region}:${accountId}:table/${physicalId}`;
      case 'StreamArn':
        // Not buildable from the table name. Heal first (issue #3627): a
        // record imported before `import()` read it back lacks it, and
        // answering here never reached the #1852 re-read.
        this.healBeforeConstructing(context);
        this.refuseUnconstructibleAttribute({
          logicalId,
          attributeName,
          resourceType,
          context,
          why: 'cdkd cannot build it from the table name',
          // The commonest way here is a table with no StreamSpecification:
          // it has no stream, so no re-read or re-import can produce one.
          remedyWhenHealCompleted:
            'A table with no StreamSpecification has no stream, and CloudFormation cannot ' +
            'return a StreamArn for it either: add a StreamSpecification to the table. If ' +
            'it already has one, change any property of the table so its next update ' +
            're-records the attributes.',
        });
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

  // S3 Bucket
  if (resourceType === 'AWS::S3::Bucket') {
    switch (attributeName) {
      case 'Arn':
        return s3BucketArn(physicalId, region);
      case 'DomainName':
        return s3BucketDomainName(physicalId, region);
      case 'RegionalDomainName':
        return s3BucketRegionalDomainName(physicalId, region);
      case 'DualStackDomainName':
        return s3BucketDualStackDomainName(physicalId, region);
      case 'WebsiteURL':
        return s3BucketWebsiteUrl(physicalId, region);
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

  // IAM Role
  if (resourceType === 'AWS::IAM::Role') {
    switch (attributeName) {
      case 'Arn':
        // The built ARN drops a non-`/` `Path`, so a record lacking `Arn` (one
        // imported before `import()` read it back) is re-read first; the
        // construction stays the answer when there is no heal (issue #3627).
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:role/${physicalId}`;
      case 'RoleId':
        // Not buildable from the role name: heal first (issue #3627).
        this.healBeforeConstructing(context);
        this.refuseUnconstructibleAttribute({
          logicalId,
          attributeName,
          resourceType,
          context,
          why: 'cdkd cannot build it from the role name',
        });
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

  // EC2 VPC - dynamic attributes (IPv6 CIDR requires DescribeVpcs after VPCCidrBlock association)
  if (resourceType === 'AWS::EC2::VPC') {
    switch (attributeName) {
      case 'VpcId':
        return physicalId;
      case 'CidrBlock':
        // Served out of the PERSISTED record, so it takes the note
        // (go-to-k/cdkd#2936). The operand that answers here is in practice
        // `properties`: `resolveGetAtt`'s flat lookup serves a PRESENT
        // `attributes.CidrBlock` first, with its own note. A whole-leaf
        // mask-only needle can still put `***` in `properties`, and served
        // unnoted it reaches the consumer's property with nothing recorded
        // for `refuseRedactedAttributeReads` to refuse.
        return this.noteAttributeSecrecy(
          logicalId,
          attributeName,
          resource.attributes?.['CidrBlock'] || resource.properties?.['CidrBlock'],
          context
        );
      case 'Ipv6CidrBlocks': {
        // Must fetch dynamically - IPv6 CIDR is added by VPCCidrBlock resource after VPC creation.
        // After CC API reports VPCCidrBlock CREATE success, the CIDR may still be in
        // 'associating' state. Retry up to 30s waiting for 'associated'.
        try {
          // Region-sensitive for the same reason as the `DescribeInstances`
          // / `DescribeLaunchTemplates` siblings below: a VPC id only
          // resolves in its own region, and a foreign-region client answers
          // `InvalidVpcID.NotFound`, which lands in the catch below and
          // degrades to an EMPTY list — a downstream `Fn::Select` on it then
          // fails, or a list-valued property ships empty. Routed through
          // `clientsForRegion` (issue #1994) rather than built here: the
          // per-call construction leaked one client + socket pool per
          // lookup and read `resolverRegion`, whose `AWS_REGION` /
          // `us-east-1` substitution is the FAIL-OPEN shape issue #1957
          // removed from the dynamic-reference lookups.
          const ec2 = this.clientsForRegion(this.explicitRegion).ec2;
          const maxAttempts = 15;
          // Through the builder (issue #3479): the id is read off the STATE
          // RECORD, which is not always AWS-assigned (`cdkd import --resource
          // <id>=<physicalId>`, a record another binary or a hand edit
          // wrote), so being an id answers the secret question, not the
          // control-character one. Bound once for the five renders below.
          const loggedId = this.displayMasked(physicalId, context);
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const resp = await ec2.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
            const associations = resp.Vpcs?.[0]?.Ipv6CidrBlockAssociationSet || [];
            const blocks = associations
              .filter((a) => a.Ipv6CidrBlockState?.State === 'associated')
              .map((a) => a.Ipv6CidrBlock);
            if (blocks.length > 0) {
              this.logger.debug(
                `Resolved VPC Ipv6CidrBlocks for ${loggedId}: ${this.displayMasked(JSON.stringify(this.maskValueLeaves(blocks, context)), context)}`
              );
              return blocks;
            }
            // Check if there are any associating CIDRs — if so, wait and retry
            const associating = associations.filter(
              (a) => a.Ipv6CidrBlockState?.State === 'associating'
            );
            if (associating.length === 0) {
              // No IPv6 CIDRs at all
              this.logger.debug(`No IPv6 CIDR associations found for VPC ${loggedId}`);
              return [];
            }
            // not-in-class(attempt): this loop's own counter, incremented by the `for` header — no template value can reach it.
            this.logger.debug(
              `VPC ${loggedId} IPv6 CIDR still associating (attempt ${attempt}/${maxAttempts}), waiting...`
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          this.logger.warn(
            `VPC ${loggedId} IPv6 CIDR did not reach 'associated' state after ${maxAttempts} attempts`
          );
          return [];
        } catch (error) {
          // The SDK message through the builder too: EC2's
          // `InvalidVpcID.NotFound` ECHOES the requested id, so sanitizing
          // only the id above would leave its copy in the message raw.
          // Rebuilt here rather than reusing `loggedId`, which the `try`
          // scopes away.
          this.logger.warn(
            `Failed to fetch VPC Ipv6CidrBlocks for ${this.displayMasked(physicalId, context)}: ${this.displayMasked(error instanceof Error ? error.message : String(error), context)}`
          );
          return [];
        }
      }
      case 'DefaultSecurityGroup': {
        // Reached only when the record OMITS the key: `resolveGetAtt`'s flat
        // lookup serves any present value first, `''` included.
        // `EC2Provider.createVpc` records the group id from a post-create
        // `DescribeSecurityGroups`, and omits the key when that read failed
        // (issue #3077), so this arm re-reads the same thing the provider
        // could not. It used to answer `attributes.DefaultSecurityGroup ||
        // physicalId` — the VPC id in a security-group position, with no
        // warning (issue #3096). A `vpc-...` can never satisfy an `sg-...`
        // slot, so a read that fails or finds nothing REFUSES instead;
        // unmarked, because the read can succeed on a retry.
        // The id goes into an EC2 FILTER value, and filters read `*` / `?`
        // as wildcards: a state record holding `vpc-*` would match every
        // VPC and serve another VPC's default group (#3096 security round).
        // Refused BEFORE the cache read AND the describe (the cache is keyed
        // by this id), and marked: the verdict is read off the persisted
        // record, which no retry rewrites, and the message interpolates the
        // logical id (#1838).
        if (!/^vpc-[0-9a-f]+$/.test(physicalId)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, DefaultSecurityGroup] for AWS::EC2::VPC: the ` +
                `state record's physical id ${quotedRender(this.displayMasked(physicalId, context).slice(0, 64), '"')} ` +
                `is not a VPC id (vpc-<hex>), so cdkd will not use it as an EC2 filter value. Repair the ` +
                `record (cdkd import, or re-create the VPC) and deploy again.`
            )
          );
        }
        const cachedGroupId = cachedVpcDefaultSecurityGroups[physicalId];
        if (cachedGroupId !== undefined) return cachedGroupId;
        let groupId: string | undefined;
        try {
          const ec2 = this.clientsForRegion(this.explicitRegion).ec2;
          const resp = await ec2.send(
            new DescribeSecurityGroupsCommand({
              Filters: [
                { Name: 'vpc-id', Values: [physicalId] },
                { Name: 'group-name', Values: ['default'] },
              ],
            })
          );
          groupId = resp.SecurityGroups?.[0]?.GroupId;
        } catch (err) {
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('DescribeSecurityGroups', err, context),
            remedy:
              'Fix the read (the vpc-id / group-name filtered DescribeSecurityGroups permission, or the region) and deploy again.',
          });
        }
        if (groupId) {
          cachedVpcDefaultSecurityGroups[physicalId] = groupId;
          return groupId;
        }
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'DescribeSecurityGroups found no group named "default" in the VPC',
          remedy: 'Check the VPC in the console, or reference the attribute from a later deploy.',
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

  // IAM Policy
  if (resourceType === 'AWS::IAM::Policy') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:iam::${accountId}:policy/${physicalId}`;
      case 'PolicyId':
        // Not an attribute of this type: the CloudFormation schema's only
        // read-only property is `Id`, so CloudFormation rejects this
        // Fn::GetAtt at template validation.
        this.refuseUndefinedAttribute({
          logicalId,
          attributeName,
          resourceType,
          context,
          defined: 'Id',
        });
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

  // IAM User
  if (resourceType === 'AWS::IAM::User') {
    switch (attributeName) {
      case 'Arn':
        // Path-less construction; heal first (issue #3627), as for the Role.
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:user/${physicalId}`;
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

  // IAM Group
  if (resourceType === 'AWS::IAM::Group') {
    switch (attributeName) {
      case 'Arn':
        // Path-less construction; heal first (issue #3627), as for the Role.
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:group/${physicalId}`;
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

  // IAM InstanceProfile
  if (resourceType === 'AWS::IAM::InstanceProfile') {
    switch (attributeName) {
      case 'Arn':
        // Path-less construction; heal first (issue #3627), as for the Role.
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:instance-profile/${physicalId}`;
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

  // KMS Key
  if (resourceType === 'AWS::KMS::Key') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:kms:${region}:${accountId}:key/${physicalId}`;
      case 'KeyId':
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

  // Cognito UserPool
  if (resourceType === 'AWS::Cognito::UserPool') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:cognito-idp:${region}:${accountId}:userpool/${physicalId}`;
      case 'UserPoolId':
        // The physical id IS the user pool id — a known-correct fallback,
        // so it must not route through the unknown-attribute guard.
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

  // Kinesis Stream
  if (resourceType === 'AWS::Kinesis::Stream') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:kinesis:${region}:${accountId}:stream/${physicalId}`;
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
  return NOT_CONSTRUCTED;
}
