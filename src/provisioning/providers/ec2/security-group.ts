import {
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  RevokeSecurityGroupEgressCommand,
  DescribeSecurityGroupsCommand,
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { definedAttributes } from '../../attribute-map.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { getStackRecords } from '../../../deployment/stack-records-scope.js';
import { generatedNameFor } from '../../resource-name.js';
import { SECURITY_GROUP_NOT_FOUND_NAMES, isNamedError } from './common.js';
import {
  SG_READBACK_NOT_FOUND_ATTEMPTS,
  SG_READBACK_RETRY_DELAY_MS,
  isDefaultEgressRule,
  securityGroupReadbackDelays,
  sgProtocolKey,
  stackIngressRuleHolder,
} from './sg-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::SecurityGroup ──────────────────────────────────────

export async function createSecurityGroup(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating SecurityGroup ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const groupDescription = properties['GroupDescription'] as string;
  if (!groupDescription) {
    throw new ProvisioningError(
      `GroupDescription is required for SecurityGroup ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // delete the group this call created.
  let leftBehindId: string | undefined;
  try {
    // Issue #2080: no idempotency token, but a replay COLLIDES on the group
    // name (`InvalidGroup.Duplicate`) rather than duplicating; the create
    // client surfaces a 5xx so `withRetry` can mark that collision (#3978).
    const createClient = await this.getCreateClient();
    const { response, tagsApplied } = await this.sendTaggedCreate(
      logicalId,
      'security-group',
      desiredTags,
      (TagSpecifications) =>
        createClient.send(
          new CreateSecurityGroupCommand({
            // go-to-k/cdkd#5095: unique per VPC, so a stack with an
            // instance id generates it; a legacy stack keeps the logical id.
            GroupName:
              (properties['GroupName'] as string) ??
              generatedNameFor('AWS::EC2::SecurityGroup', logicalId),
            Description: groupDescription,
            VpcId: (properties['VpcId'] as string) ?? undefined,
            ...(TagSpecifications && { TagSpecifications }),
          })
        )
    );

    const groupId = response.GroupId!;
    // go-to-k/cdkd#5511: report before the wiring calls.
    reportCreatedResource(logicalId, resourceType, groupId);

    // CreateSecurityGroupCommand has succeeded — AWS has now committed
    // the SG. If applyTags / Authorize* / Revoke* throws, the SG exists
    // on AWS but cdkd state will NOT. The next redeploy plans CREATE
    // and AWS would reject with `InvalidGroup.Duplicate: The security
    // group '<name>' already exists for VPC ...`: the name (the template's
    // GroupName, else the logical id) cannot repeat in a VPC, so every
    // redeploy fails until the orphan is deleted by hand. Wrap wiring in
    // an inner try/catch that issues a best-effort
    // `DeleteSecurityGroupCommand` before re-throwing the original error.
    // A freshly-created SG has no ENIs / dependents
    // attached, so a single DeleteSecurityGroup suffices (its inline
    // rules CASCADE-delete with the SG).
    try {
      // Wiring a freshly-created SG used to be a fully serialized chain:
      // CreateTags -> one AuthorizeSecurityGroupIngress PER RULE ->
      // RevokeSecurityGroupEgress -> one AuthorizeSecurityGroupEgress PER
      // RULE. On a typical CDK L2 SG (1 tag set, 1 ingress rule, 1 egress
      // rule) that is 4 sequential round trips on the deploy critical path.
      //
      // Two independent fixes, neither of which changes the end state:
      //   1. Tagging and the two rule DIRECTIONS are mutually independent
      //      (distinct AWS APIs, distinct rule sets on the group), so they
      //      run concurrently. Within the egress branch the revoke still
      //      strictly precedes the authorize (see below).
      //   2. Authorize{Ingress,Egress} accept an `IpPermissions` ARRAY, so
      //      N rules become ONE call instead of N.
      //
      // Failure semantics are unchanged, but ONLY because every branch is
      // drained first. A bare `Promise.all` over the three branches rejects
      // the moment the first one does, while the other two are still in
      // flight -- so the outer catch would issue DeleteSecurityGroup
      // concurrently with a pending Authorize / Revoke / CreateTags on the
      // same group. That delete comes back DependencyViolation or
      // InvalidGroup.NotFound, the cleanup only warns, and the half-wired SG
      // leaks: exactly the orphan the cleanup exists to prevent. Serially
      // this could not happen, because nothing was in flight at cleanup time.
      //
      // The drain waits for all three to settle before anything is thrown,
      // so the group is quiescent when the delete goes out. Of several
      // rejections, the one rethrown is the one that FAILED FIRST IN TIME
      // (issue #2804) -- not the first by array position, which is what a
      // scan of `Promise.allSettled`'s results would pick: each branch gets
      // its own `catch`, so the callbacks run in rejection order and the
      // first to fire wins. That choice is visible: the retry classifiers
      // read the message. Every branch is `catch`-ed, so the rejections not
      // rethrown cannot surface as unhandled.
      const ingressRules = properties['SecurityGroupIngress'] as
        | Array<Record<string, unknown>>
        | undefined;
      const egressRules = properties['SecurityGroupEgress'] as
        | Array<Record<string, unknown>>
        | undefined;

      // Wrapped, so a branch rejecting with `undefined` still counts as a
      // rejection.
      let firstRejection: { readonly error: unknown } | undefined;
      const recordRejection = (branch: Promise<unknown>): Promise<unknown> =>
        branch.catch((error: unknown) => {
          firstRejection ??= { error };
        });
      await Promise.all([
        // Only tags the create did not carry (go-to-k/cdkd#4971).
        recordRejection(
          this.applyTags(
            groupId,
            tagsApplied ? [] : desiredTags,
            logicalId,
            maskerOrIdentity(context?.maskSecrets)
          )
        ),
        recordRejection(this.authorizeInlineIngress(groupId, ingressRules)),
        recordRejection(this.applyInlineEgress(groupId, egressRules)),
      ]);
      if (firstRejection !== undefined) {
        throw firstRejection.error;
      }
    } catch (innerError) {
      try {
        await this.ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
        retractCreatedResource(logicalId, resourceType, groupId);
        this.logger.debug(
          `Cleaned up partially-created SecurityGroup ${logicalId} (${groupId}) after wiring failure`
        );
      } catch (cleanupError) {
        leftBehindId = groupId;
        const cleanupHead = `Failed to clean up partially-created SecurityGroup ${logicalId} (${groupId}): `;
        this.logger.warn(
          `${cleanupHead}${this.warnFailureSentence(cleanupHead, cleanupError, maskerOrIdentity(context?.maskSecrets))} Manual deletion may be required before the next deploy: ${pasteableAwsCommand()`aws ec2 delete-security-group --group-id ${groupId}`.render()}`
        );
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    this.logger.debug(`Successfully created SecurityGroup ${logicalId}: ${groupId}`);

    return {
      physicalId: groupId,
      attributes: definedAttributes({
        GroupId: groupId,
        VpcId: await this.readSecurityGroupVpcId(groupId),
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create SecurityGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (leftBehindId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindId);
    }
    throw thrown;
  }
}

/**
 * Authorize a freshly-created security group's inline
 * `SecurityGroupIngress` rules in a SINGLE `AuthorizeSecurityGroupIngress`
 * call.
 *
 * The API takes an `IpPermissions` ARRAY; the previous per-rule loop paid
 * one round trip per rule for no benefit. AWS applies the whole list
 * atomically, so the resulting rule set is byte-identical — the only
 * behavior difference is that a bad rule now rejects the batch instead of
 * being preceded by its already-applied siblings, and the caller deletes
 * the half-wired group in either case.
 */
export async function authorizeInlineIngress(
  this: EC2Provider,
  groupId: string,
  ingressRules: Array<Record<string, unknown>> | undefined
): Promise<void> {
  if (!Array.isArray(ingressRules) || ingressRules.length === 0) return;
  await this.ec2Client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: ingressRules.map((rule) => this.buildIpPermission(rule, 'ingress', true)),
    })
  );
}

/**
 * Apply a freshly-created security group's inline `SecurityGroupEgress`
 * rules.
 *
 * When a template specifies egress explicitly, CloudFormation replaces the
 * AWS-default "allow all egress" rule (`-1` / `0.0.0.0/0`) with the
 * supplied set, so cdkd revokes the default first and then authorizes the
 * template's rules. Both steps are preserved, including for an EMPTY
 * `SecurityGroupEgress: []` — that is a deliberate "no egress at all",
 * which requires the revoke and no authorize.
 *
 * Two round trips are saved where they are provably redundant:
 *
 *   - The whole revoke+authorize pair is SKIPPED when the templated egress
 *     is exactly the rule AWS already created by default. `isDefaultEgressRule`
 *     is the exact comparator (protocol `-1`, `CidrIp 0.0.0.0/0`, no IPv6
 *     range / peer group / prefix list / description, ports absent or `-1`)
 *     and is the SAME predicate the drift reverse-mapper uses to recognize
 *     the AWS default, so the two cannot disagree about what "default" means.
 *     AWS creates exactly ONE default egress rule and it is IPv4-only (there
 *     is no `::/0` default), which is why a single-element match is the right
 *     shape. NOTE this deliberately does NOT fire for the CDK L2
 *     `allowAllOutbound: true` shape, which stamps
 *     `Description: 'Allow all outbound traffic by default'` — the AWS
 *     default rule carries no description, so skipping there would leave the
 *     group in a state CloudFormation would not produce AND would surface as
 *     permanent phantom drift (`readCurrentState` would report no
 *     Description while state records one).
 *   - The remaining authorize is a SINGLE batched call rather than one per
 *     rule (see {@link authorizeInlineIngress}).
 */
export async function applyInlineEgress(
  this: EC2Provider,
  groupId: string,
  egressRules: Array<Record<string, unknown>> | undefined
): Promise<void> {
  if (!Array.isArray(egressRules)) return;

  if (egressRules.length === 1 && isDefaultEgressRule(egressRules[0]!)) {
    this.logger.debug(
      `SecurityGroup ${groupId} egress equals the AWS default allow-all rule; ` +
        `skipping the redundant revoke + re-authorize`
    );
    return;
  }

  // Revoke the AWS-default "allow all egress" rule so it does not coexist
  // with user-specified rules. Tolerate "not found" if the default is absent.
  try {
    await this.ec2Client.send(
      new RevokeSecurityGroupEgressCommand({
        GroupId: groupId,
        IpPermissions: [
          {
            IpProtocol: '-1',
            IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          },
        ],
      })
    );
  } catch (error) {
    if (!this.isNotFoundError(error)) {
      throw error;
    }
  }

  if (egressRules.length === 0) return;
  await this.ec2Client.send(
    new AuthorizeSecurityGroupEgressCommand({
      GroupId: groupId,
      IpPermissions: egressRules.map((rule) => this.buildIpPermission(rule, 'egress')),
    })
  );
}

export async function updateSecurityGroup(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating SecurityGroup ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // Update tags (diff add/remove against previousProperties)
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskerOrIdentity(context?.maskSecrets)
    );

    // Diff and apply ingress rule changes (symmetric with egress below).
    await this.applySecurityGroupRuleDiff(
      physicalId,
      (previousProperties['SecurityGroupIngress'] as Array<Record<string, unknown>>) ?? [],
      (properties['SecurityGroupIngress'] as Array<Record<string, unknown>>) ?? [],
      'ingress',
      logicalId
    );

    // Diff and apply egress rule changes
    await this.applySecurityGroupRuleDiff(
      physicalId,
      (previousProperties['SecurityGroupEgress'] as Array<Record<string, unknown>>) ?? [],
      (properties['SecurityGroupEgress'] as Array<Record<string, unknown>>) ?? [],
      'egress',
      logicalId
    );

    this.logger.debug(`Successfully updated SecurityGroup ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: definedAttributes({
        GroupId: physicalId,
        VpcId: await this.readSecurityGroupVpcId(physicalId),
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update SecurityGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteSecurityGroup(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting SecurityGroup ${logicalId}: ${physicalId}`);

  // Retry with backoff for "dependent object" errors (e.g., ECS ENI cleanup delay)
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: physicalId }));
      this.logger.debug(`Successfully deleted SecurityGroup ${logicalId}`);
      return;
    } catch (error) {
      // go-to-k/cdkd#4606: a journaled orphan counts as gone only on
      // EC2's own not-found code; the broad matcher's message
      // substrings would clear a live orphan from the journal.
      if (
        this.isNotFoundError(error) &&
        (context?.failedCreateOrphan !== true ||
          isNamedError(error, SECURITY_GROUP_NOT_FOUND_NAMES))
      ) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  Security group ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`SecurityGroup ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      // The thrown `ProvisioningError` further down names an AWS-authored
      // failure by its class only (`wrapCaughtError`, go-to-k/cdkd#2319).
      const msg = describeAwsFailure(error).detail;
      if (msg.includes('dependent object') && attempt < maxAttempts) {
        // Same side-channel as deleteSubnet: clean up Lambda-managed
        // ENIs that still reference this SG, then sleep and retry.
        await this.cleanupSecurityGroupLambdaEnis(physicalId);
        this.logger.debug(
          `SecurityGroup ${physicalId} has dependent objects (attempt ${attempt}/${maxAttempts}), retrying in ${attempt * 5}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        continue;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete SecurityGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }
}

/**
 * Best-effort: list Lambda-managed ENIs that reference the given security
 * group and try to delete each one. Mirror of cleanupSubnetLambdaEnis but
 * filtered by `group-id`.
 */
export async function cleanupSecurityGroupLambdaEnis(
  this: EC2Provider,
  groupId: string
): Promise<void> {
  let enis: { id: string; status: string }[];
  try {
    const resp = await this.ec2Client.send(
      new DescribeNetworkInterfacesCommand({
        Filters: [
          { Name: 'group-id', Values: [groupId] },
          // See cleanupSubnetLambdaEnis: requester-id does not contain
          // "awslambda" — filter on description instead.
          { Name: 'description', Values: ['AWS Lambda VPC ENI-*'] },
        ],
      })
    );
    enis = (resp.NetworkInterfaces ?? [])
      .filter((ni) => ni.NetworkInterfaceId)
      .map((ni) => ({ id: ni.NetworkInterfaceId!, status: ni.Status ?? 'unknown' }));
  } catch (err) {
    this.logger.debug(
      `cleanupSecurityGroupLambdaEnis: DescribeNetworkInterfaces failed for ${groupId}: ${
        describeAwsFailure(err).detail
      }`
    );
    return;
  }
  if (enis.length === 0) return;
  await Promise.all(
    enis.map(async (eni) => {
      try {
        await this.ec2Client.send(
          new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eni.id })
        );
        this.logger.debug(
          `cleanupSecurityGroupLambdaEnis: deleted Lambda ENI ${eni.id} for SG ${groupId}`
        );
      } catch (err) {
        this.logger.debug(
          `cleanupSecurityGroupLambdaEnis: ENI ${eni.id} (status=${eni.status}) not yet deletable: ${
            describeAwsFailure(err).detail
          }`
        );
      }
    })
  );
}

/**
 * The `VpcId` a security group's `attributes` map records, read back from
 * `DescribeSecurityGroups` on the group id (issue #3097).
 *
 * The two `AWS::EC2::SecurityGroup` result maps used to copy the TEMPLATE's
 * own `VpcId` property with a `?? ''` fallback — the last two sites issue
 * #3077 left on that shape. A `CfnSecurityGroup` declared without `VpcId`
 * lands in the account's default VPC, so the template has nothing to copy
 * and the record held `''` where CloudFormation answers the default VPC's
 * id. The read-back answers both shapes the same way: `CreateSecurityGroup`
 * returns only the group id, and the describe reports `VpcId` for an
 * explicit VPC and for the default one alike.
 *
 * Best-effort by design: the group is already created (or updated) and
 * wired when this runs, so a failed or empty read must not fail the
 * resource. It answers `undefined` then, which `definedAttributes` turns
 * into an ABSENT key — never `''` — and the resolver's
 * `AWS::EC2::SecurityGroup` `VpcId` arm re-reads it live on the next
 * `Fn::GetAtt`. The error CLASS (and HTTP status when the SDK attached one)
 * is what the debug line names at its head; AWS's own text follows it on the
 * same debug line, since a denied describe quotes the caller's account, role
 * and session (`.claude/rules/provider-resource-identity.md`).
 *
 * EC2's read API is eventually consistent: a `DescribeSecurityGroups` issued
 * right after `CreateSecurityGroup` can answer `InvalidGroup.NotFound` for a
 * group the write path already accepted tags and rules for (#3139 review).
 * An answer `isNotFoundError` classifies as not-found (a substring
 * predicate — on this API that is `InvalidGroup.NotFound`) is therefore
 * retried a bounded number of times (`SG_READBACK_NOT_FOUND_ATTEMPTS`,
 * `SG_READBACK_RETRY_DELAY_MS` apart) before the key is omitted; every
 * other failure, and an EMPTY answer, omits at once. On the update path a
 * group deleted out of band takes the same bounded wait and then omits —
 * its own rule / tag calls MAY already have failed, but an update whose
 * bags agree issues none, and the rollback replay / `drift --revert` reach
 * `updateSecurityGroup` too, so this read can be the first call to touch
 * it. `getSecurityGroupAttribute` (the orphan rewriter's live fetch) shares
 * the wait. The sleep itself is inside the best-effort boundary: a
 * rejecting sleep (only a test seam can reject) omits like a failed read.
 */
export async function readSecurityGroupVpcId(
  this: EC2Provider,
  groupId: string
): Promise<string | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await this.ec2Client.send(
        new DescribeSecurityGroupsCommand({ GroupIds: [groupId] })
      );
      const vpcId = response?.SecurityGroups?.[0]?.VpcId;
      if (vpcId === undefined) {
        this.logger.debug(
          `DescribeSecurityGroups reported no VpcId for SecurityGroup ${groupId}; omitting the attribute`
        );
      }
      return vpcId;
    } catch (error) {
      const name = error instanceof Error && error.name ? error.name : 'Error';
      const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
        ?.httpStatusCode;
      const errorClass = typeof status === 'number' ? `${name}, HTTP ${status}` : name;
      if (this.isNotFoundError(error) && attempt < SG_READBACK_NOT_FOUND_ATTEMPTS) {
        this.logger.debug(
          `DescribeSecurityGroups for SecurityGroup ${groupId} answered not-found (${errorClass}) on attempt ${attempt}/${SG_READBACK_NOT_FOUND_ATTEMPTS}; retrying in ${SG_READBACK_RETRY_DELAY_MS}ms (eventual consistency)`
        );
        try {
          await (securityGroupReadbackDelays.sleep ?? ((ms) => this.sleep(ms)))(
            SG_READBACK_RETRY_DELAY_MS
          );
        } catch {
          this.logger.debug(
            `DescribeSecurityGroups retry sleep for SecurityGroup ${groupId} rejected; omitting the VpcId attribute`
          );
          return undefined;
        }
        continue;
      }
      this.logger.debug(
        `DescribeSecurityGroups for SecurityGroup ${groupId} failed (${errorClass}); omitting the VpcId attribute: ${describeAwsFailure(error).detail}`
      );
      return undefined;
    }
  }
}

export async function getSecurityGroupAttribute(
  this: EC2Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'GroupId') return physicalId;
  if (attributeName === 'VpcId') return this.readSecurityGroupVpcId(physicalId);
  return undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Build an IpPermission object from CloudFormation-style properties.
 *
 * The EC2 IpPermission shape is identical for ingress and egress; only the
 * CFn property names that point to the "other" security group differ
 * (SourceSecurityGroupId vs DestinationSecurityGroupId).
 */
export function buildIpPermission(
  this: EC2Provider,
  properties: Record<string, unknown>,
  direction: 'ingress' | 'egress' = 'ingress',
  /**
   * An inline `AWS::EC2::SecurityGroup` rule. Only it sends
   * `SourceSecurityGroupName` (go-to-k/cdkd#5478): CloudFormation refuses the
   * member on a standalone `AWS::EC2::SecurityGroupIngress` ("Exactly one of
   * CidrIp, CidrIpv6, SourceSecurityGroupId, and SourcePrefixListId must be
   * specified"), which `unhandledByDesign` declares.
   */
  inline = false
): {
  IpProtocol: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: Array<{ CidrIp: string; Description?: string }>;
  Ipv6Ranges?: Array<{ CidrIpv6: string; Description?: string }>;
  UserIdGroupPairs?: Array<{
    GroupId?: string;
    GroupName?: string;
    UserId?: string;
    Description?: string;
  }>;
  PrefixListIds?: Array<{ PrefixListId: string; Description?: string }>;
} {
  const ipProtocol = (properties['IpProtocol'] as string) ?? '-1';
  const fromPort = properties['FromPort'] as number | undefined;
  const toPort = properties['ToPort'] as number | undefined;

  const permission: {
    IpProtocol: string;
    FromPort?: number;
    ToPort?: number;
    IpRanges?: Array<{ CidrIp: string; Description?: string }>;
    Ipv6Ranges?: Array<{ CidrIpv6: string; Description?: string }>;
    UserIdGroupPairs?: Array<{
      GroupId?: string;
      GroupName?: string;
      UserId?: string;
      Description?: string;
    }>;
    PrefixListIds?: Array<{ PrefixListId: string; Description?: string }>;
  } = { IpProtocol: ipProtocol };

  if (fromPort !== undefined) permission.FromPort = fromPort;
  if (toPort !== undefined) permission.ToPort = toPort;

  const cidrIp = properties['CidrIp'] as string | undefined;
  const cidrIpv6 = properties['CidrIpv6'] as string | undefined;
  const description = properties['Description'] as string | undefined;
  if (cidrIp) {
    const ipRange: { CidrIp: string; Description?: string } = { CidrIp: cidrIp };
    if (description) ipRange.Description = description;
    permission.IpRanges = [ipRange];
  }
  if (cidrIpv6) {
    const ipv6Range: { CidrIpv6: string; Description?: string } = { CidrIpv6: cidrIpv6 };
    if (description) ipv6Range.Description = description;
    permission.Ipv6Ranges = [ipv6Range];
  }

  // Source SG (ingress) and destination SG (egress) map to the same
  // UserIdGroupPairs slot on the underlying EC2 IpPermission shape.
  const peerGroupId =
    direction === 'egress'
      ? (properties['DestinationSecurityGroupId'] as string | undefined)
      : (properties['SourceSecurityGroupId'] as string | undefined);
  // go-to-k/cdkd#5478: an ingress peer named by `SourceSecurityGroupName` (a
  // default-VPC group) goes out as `UserIdGroupPairs[].GroupName`, as
  // CloudFormation sends it (measured in a default VPC: the rule was created
  // with the named group as its peer). An id, when both are given, wins.
  const peerGroupName =
    inline && direction === 'ingress'
      ? (properties['SourceSecurityGroupName'] as string | undefined)
      : undefined;
  if (peerGroupId || peerGroupName) {
    const groupPair: {
      GroupId?: string;
      GroupName?: string;
      UserId?: string;
      Description?: string;
    } = peerGroupId ? { GroupId: peerGroupId } : { GroupName: peerGroupName as string };
    // Cross-account peer reference: CFn supports SourceSecurityGroupOwnerId on
    // ingress rules to point at a security group in another AWS account. Map
    // it to the UserIdGroupPairs[].UserId field on the EC2 API. CFn does not
    // define a Destination*OwnerId counterpart for egress, so this is
    // ingress-only.
    if (direction === 'ingress') {
      const peerOwnerId = properties['SourceSecurityGroupOwnerId'] as string | undefined;
      if (peerOwnerId) groupPair.UserId = peerOwnerId;
    }
    if (description) groupPair.Description = description;
    permission.UserIdGroupPairs = [groupPair];
  }

  // Prefix list (egress only in CFn, but harmless to read for both)
  const prefixListId =
    direction === 'egress'
      ? (properties['DestinationPrefixListId'] as string | undefined)
      : (properties['SourcePrefixListId'] as string | undefined);
  if (prefixListId) {
    const prefixEntry: { PrefixListId: string; Description?: string } = {
      PrefixListId: prefixListId,
    };
    if (description) prefixEntry.Description = description;
    permission.PrefixListIds = [prefixEntry];
  }

  return permission;
}

/**
 * Compute the diff between two sets of SecurityGroup rule definitions
 * (ingress or egress) and apply the resulting authorize/revoke calls.
 *
 * Rules are identified by a deterministic key derived from their full
 * shape — protocol, ports, CIDR, peer group, prefix list, description —
 * so updating any of those fields counts as a replacement (revoke + authorize).
 */
export async function applySecurityGroupRuleDiff(
  this: EC2Provider,
  groupId: string,
  previousRules: Array<Record<string, unknown>>,
  nextRules: Array<Record<string, unknown>>,
  direction: 'ingress' | 'egress',
  /** The group's logical id; only an INGRESS revoke asks which other records hold the rule. */
  logicalId?: string
): Promise<void> {
  const ruleKey = (rule: Record<string, unknown>): string => {
    const peerKey =
      direction === 'egress'
        ? (rule['DestinationSecurityGroupId'] as string | undefined)
        : (rule['SourceSecurityGroupId'] as string | undefined);
    const prefixKey =
      direction === 'egress'
        ? (rule['DestinationPrefixListId'] as string | undefined)
        : (rule['SourcePrefixListId'] as string | undefined);
    // Include the cross-account peer owner id (ingress only) so a same-id
    // group in a different account is not collapsed into the same rule.
    const peerOwner =
      direction === 'ingress'
        ? (rule['SourceSecurityGroupOwnerId'] as string | undefined)
        : undefined;
    // go-to-k/cdkd#5478: a peer named by group name is a rule of its own.
    // Keyed only when no id is given, since the wire then sends the id
    // alone: a redundant name must not churn revoke / authorize. `sgRuleKey`
    // (the drift read side) does not key the name, because AWS reports the
    // peer by id, so a `cdkd drift --revert` of a name-only rule re-attaches
    // it (revoke + authorize of the same peer).
    const peerName =
      direction === 'ingress' ? (rule['SourceSecurityGroupName'] as string | undefined) : undefined;
    return JSON.stringify({
      // Same canonicalization as `sgRuleKey` (issue #1643) — the two keys
      // MUST agree, which is what this function's sibling JSDoc promises.
      // Without it a `--revert` of a drifted inline rule set keys the
      // previous side (AWS's `tcp`) differently from the desired side
      // (state's `'6'`), so EVERY rule is revoked and re-authorized instead
      // of only the drifted one — a window with no rules on a live group.
      p: sgProtocolKey(rule['IpProtocol']),
      f: rule['FromPort'] ?? null,
      t: rule['ToPort'] ?? null,
      c4: rule['CidrIp'] ?? null,
      c6: rule['CidrIpv6'] ?? null,
      peer: peerKey ?? null,
      peerName: peerKey ? null : (peerName ?? null),
      peerOwner: peerOwner ?? null,
      pl: prefixKey ?? null,
      d: rule['Description'] ?? null,
    });
  };

  const prevByKey = new Map<string, Record<string, unknown>>();
  for (const rule of previousRules) prevByKey.set(ruleKey(rule), rule);
  const nextByKey = new Map<string, Record<string, unknown>>();
  for (const rule of nextRules) nextByKey.set(ruleKey(rule), rule);

  const toRevoke: Array<Record<string, unknown>> = [];
  for (const [key, rule] of prevByKey) {
    if (!nextByKey.has(key)) toRevoke.push(rule);
  }
  const toAuthorize: Array<Record<string, unknown>> = [];
  for (const [key, rule] of nextByKey) {
    if (!prevByKey.has(key)) toAuthorize.push(rule);
  }

  for (const rule of toRevoke) {
    // go-to-k/cdkd#4492: a standalone `SecurityGroupIngress` record of this
    // stack that outlives the update holds the same rule, so dropping it from
    // the group's inline list must not revoke it.
    if (direction === 'ingress' && logicalId !== undefined) {
      const holder = stackIngressRuleHolder(
        getStackRecords()?.survivors(),
        logicalId,
        groupId,
        rule
      );
      if (holder !== undefined) {
        this.logger.info(
          safeMsg`SecurityGroup ${logicalId}: an ingress rule dropped from it is also held by ${holder} of this stack, so it was left in place`
        );
        continue;
      }
    }
    try {
      if (direction === 'egress') {
        await this.ec2Client.send(
          new RevokeSecurityGroupEgressCommand({
            GroupId: groupId,
            IpPermissions: [this.buildIpPermission(rule, 'egress')],
          })
        );
      } else {
        await this.ec2Client.send(
          new RevokeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [this.buildIpPermission(rule, 'ingress', true)],
          })
        );
      }
    } catch (error) {
      if (!this.isNotFoundError(error)) throw error;
    }
  }

  for (const rule of toAuthorize) {
    try {
      if (direction === 'egress') {
        await this.ec2Client.send(
          new AuthorizeSecurityGroupEgressCommand({
            GroupId: groupId,
            IpPermissions: [this.buildIpPermission(rule, 'egress')],
          })
        );
      } else {
        await this.ec2Client.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [this.buildIpPermission(rule, 'ingress', true)],
          })
        );
      }
    } catch (error) {
      // Tolerate "already exists" to keep the diff idempotent across retries.
      if (!(error instanceof Error && error.message.includes('already exists'))) {
        throw error;
      }
    }
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const securityGroupMethods = {
  createSecurityGroup,
  authorizeInlineIngress,
  applyInlineEgress,
  updateSecurityGroup,
  deleteSecurityGroup,
  cleanupSecurityGroupLambdaEnis,
  readSecurityGroupVpcId,
  getSecurityGroupAttribute,
  buildIpPermission,
  applySecurityGroupRuleDiff,
};
