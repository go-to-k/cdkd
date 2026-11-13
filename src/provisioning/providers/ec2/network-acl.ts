import {
  CreateNetworkAclCommand,
  DeleteNetworkAclCommand,
  CreateNetworkAclEntryCommand,
  DeleteNetworkAclEntryCommand,
  ReplaceNetworkAclEntryCommand,
  ReplaceNetworkAclAssociationCommand,
  DescribeNetworkAclsCommand,
} from '@aws-sdk/client-ec2';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  compositeIdFormatMessage,
  compositeIdSkipResult,
  packCompositeId,
} from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { EC2_NETWORK_ACL_ENTRY_ID_FORMAT, networkAclEntryRuleParams } from './network-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::NetworkAcl ────────────────────────────────────────

export async function createNetworkAcl(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating NetworkAcl ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const vpcId = properties['VpcId'] as string;
  if (!vpcId) {
    throw new ProvisioningError(
      `VpcId is required for NetworkAcl ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Issue #2039: a replayed create would leave an unstated network ACL
  // behind. Same release rule as the NAT gateway above.
  const networkAclToken = acquireIdempotencyToken({
    scope: 'CreateNetworkAcl',
    logicalId,
  });

  try {
    const { response, tagsApplied } = await this.sendTaggedCreate(
      logicalId,
      'network-acl',
      desiredTags,
      (TagSpecifications) =>
        this.ec2Client.send(
          new CreateNetworkAclCommand({
            VpcId: vpcId,
            ClientToken: networkAclToken.value,
            ...(TagSpecifications && { TagSpecifications }),
          })
        )
    );

    const networkAclId = response.NetworkAcl!.NetworkAclId!;

    // Apply tags the create did not carry (go-to-k/cdkd#4971)
    if (!tagsApplied)
      await this.applyTags(
        networkAclId,
        desiredTags,
        logicalId,
        maskerOrIdentity(context?.maskSecrets)
      );

    this.logger.debug(`Successfully created NetworkAcl ${logicalId}: ${networkAclId}`);

    networkAclToken.release();
    return {
      physicalId: networkAclId,
      attributes: {
        Id: networkAclId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create NetworkAcl ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteNetworkAcl(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting NetworkAcl ${logicalId}: ${physicalId}`);

  try {
    await this.ec2Client.send(new DeleteNetworkAclCommand({ NetworkAclId: physicalId }));
    this.logger.debug(`Successfully deleted NetworkAcl ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`NetworkAcl ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete NetworkAcl ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EC2::NetworkAclEntry ─────────────────────────────────────

export async function createNetworkAclEntry(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating NetworkAclEntry ${logicalId}`);

  const networkAclId = properties['NetworkAclId'] as string;
  const ruleNumber = properties['RuleNumber'] as number;
  const protocol = properties['Protocol'] as number;
  const ruleAction = properties['RuleAction'] as string;
  const egress = (properties['Egress'] as boolean) ?? false;

  if (!networkAclId || ruleNumber === undefined || protocol === undefined || !ruleAction) {
    throw new ProvisioningError(
      `NetworkAclId, RuleNumber, Protocol, and RuleAction are required for NetworkAclEntry ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // No segment here is pipe-capable — an AWS-generated `acl-...`, a number
  // and a boolean — so this is uniform defense-in-depth (issue #1672).
  // Computed before the AWS call so a refusal cannot leave an entry AWS has
  // already created without a state record.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'networkAclId', value: networkAclId },
      { name: 'ruleNumber', value: ruleNumber },
      { name: 'egress', value: egress },
    ],
    {
      // Issue #2176: the refusal QUOTES the offending segment value, on the
      // thrown arm (durable) and the warn arm (terminal) alike, so the masker
      // goes through unconditionally -- it is absent on the paths that have no
      // context, where it degrades to identity.
      maskSecrets: context?.maskSecrets,
      ...(context?.replayingState === true && {
        onRefusal: (message: string) => this.logger.warn(message),
      }),
    }
  );

  try {
    await this.ec2Client.send(
      new CreateNetworkAclEntryCommand({
        NetworkAclId: networkAclId,
        RuleNumber: ruleNumber,
        Egress: egress,
        ...networkAclEntryRuleParams(properties),
      })
    );

    this.logger.debug(`Successfully created NetworkAclEntry ${logicalId}: ${physicalId}`);

    return {
      physicalId,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create NetworkAclEntry ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteNetworkAclEntry(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting NetworkAclEntry ${logicalId}: ${physicalId}`);

  const parts = physicalId.split('|');
  if (parts.length < 3) {
    this.logger.warn(
      compositeIdFormatMessage(EC2_NETWORK_ACL_ENTRY_ID_FORMAT, logicalId, physicalId, {
        skipping: true,
        context,
      })
    );
    // Issue #1752: report the SKIP rather than returning void — a bare
    // `return` was counted as a successful delete by the destroy summary.
    return compositeIdSkipResult();
  }
  const networkAclId = parts[0]!;
  const ruleNumber = parseInt(parts[1]!, 10);
  const egress = parts[2] === 'true';

  try {
    await this.ec2Client.send(
      new DeleteNetworkAclEntryCommand({
        NetworkAclId: networkAclId,
        RuleNumber: ruleNumber,
        Egress: egress,
      })
    );
    this.logger.debug(`Successfully deleted NetworkAclEntry ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`NetworkAclEntry ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete NetworkAclEntry ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Issue #5070: `NetworkAclId`, `RuleNumber` and `Egress` are createOnly and
 * name the entry; every other property (`RuleAction`, `Protocol`,
 * `CidrBlock`, `Ipv6CidrBlock`, `PortRange`, `Icmp`) is "Update requires: No
 * interruption" in CloudFormation, which EC2 serves with the single atomic
 * `ReplaceNetworkAclEntry`. A delete + create (the `--replace` remedy the
 * old refusal pointed at) leaves the rule number absent between the two
 * calls, so traffic falls through to the next rule for the window.
 */
export async function updateNetworkAclEntry(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // No-op short-circuit: a `cdkd drift --revert` round-trip can call
  // update() with new == old when only sibling resources drifted.
  if (JSON.stringify(properties) === JSON.stringify(previousProperties)) {
    return { physicalId, wasReplaced: false };
  }

  // The identity check decides the arm, not the createOnly premise: the
  // engine replaces on a changed key, so a bag naming a different entry
  // than the physical id should not reach here, and is refused as before
  // rather than rewriting some other rule number in place.
  const networkAclId = properties['NetworkAclId'];
  const ruleNumber = properties['RuleNumber'];
  const egress = properties['Egress'] ?? false;
  const parts = physicalId.split('|');
  if (parts.length !== 3) {
    throw new ProvisioningError(
      compositeIdFormatMessage(EC2_NETWORK_ACL_ENTRY_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }
  if (
    typeof networkAclId !== 'string' ||
    ruleNumber === undefined ||
    parts[0] !== networkAclId ||
    parts[1] !== String(ruleNumber) ||
    parts[2] !== String(egress)
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `NetworkAclId, RuleNumber and Egress identify the entry and are createOnly; a change to any of them requires a new entry. Re-deploy with ${deployReplaceCommand()}, or destroy + redeploy`
    );
  }

  if (properties['Protocol'] == null || !properties['RuleAction']) {
    throw new ProvisioningError(
      `Protocol and RuleAction are required for NetworkAclEntry ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // `networkAclEntryRuleParams` prefers `Icmp` over the legacy
  // `IcmpTypeCode`. A `drift --revert` bag carries both (the readback emits
  // both names) but overlays only the key the state record holds, so for a
  // pre-#613 record the recorded ICMP is in `IcmpTypeCode` while `Icmp`
  // still holds the drifted AWS value: send the key that changed.
  const preferLegacyIcmp =
    properties['Icmp'] !== undefined &&
    properties['IcmpTypeCode'] !== undefined &&
    JSON.stringify(properties['Icmp']) === JSON.stringify(previousProperties['Icmp']) &&
    JSON.stringify(properties['IcmpTypeCode']) !==
      JSON.stringify(previousProperties['IcmpTypeCode']);

  // The same overlay can leave both CIDR keys set when the entry's address
  // family changed out-of-band (state recorded `CidrBlock`, AWS now holds
  // `Ipv6CidrBlock`), and AWS rejects a rule naming both: send the key that
  // changed and drop the AWS-side one. Only for the readback bag — a
  // template naming both is the user's to fix, so AWS's refusal stands.
  const ruleParams = networkAclEntryRuleParams(properties, preferLegacyIcmp);
  if (
    context?.desiredFromAwsReadback === true &&
    ruleParams.CidrBlock !== undefined &&
    ruleParams.Ipv6CidrBlock !== undefined
  ) {
    const v4Changed = properties['CidrBlock'] !== previousProperties['CidrBlock'];
    const v6Changed = properties['Ipv6CidrBlock'] !== previousProperties['Ipv6CidrBlock'];
    if (v4Changed && !v6Changed) ruleParams.Ipv6CidrBlock = undefined;
    else if (v6Changed && !v4Changed) ruleParams.CidrBlock = undefined;
  }

  try {
    await this.ec2Client.send(
      new ReplaceNetworkAclEntryCommand({
        NetworkAclId: networkAclId,
        RuleNumber: parseInt(parts[1]!, 10),
        Egress: parts[2] === 'true',
        ...ruleParams,
      })
    );
    this.logger.debug(safeMsg`Successfully replaced NetworkAclEntry ${logicalId} in place`);
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update NetworkAclEntry ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EC2::SubnetNetworkAclAssociation ─────────────────────────

export async function createSubnetNetworkAclAssociation(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating SubnetNetworkAclAssociation ${logicalId}`);

  const networkAclId = properties['NetworkAclId'] as string;
  const subnetId = properties['SubnetId'] as string;

  if (!networkAclId || !subnetId) {
    throw new ProvisioningError(
      `NetworkAclId and SubnetId are required for SubnetNetworkAclAssociation ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    // Find the current NACL association for the subnet
    const describeResponse = await this.ec2Client.send(
      new DescribeNetworkAclsCommand({
        Filters: [{ Name: 'association.subnet-id', Values: [subnetId] }],
      })
    );

    let currentAssociationId: string | undefined;
    for (const nacl of describeResponse.NetworkAcls ?? []) {
      for (const assoc of nacl.Associations ?? []) {
        if (assoc.SubnetId === subnetId) {
          currentAssociationId = assoc.NetworkAclAssociationId;
          break;
        }
      }
      if (currentAssociationId) break;
    }

    if (!currentAssociationId) {
      throw new ProvisioningError(
        `No current NACL association found for subnet ${subnetId}`,
        resourceType,
        logicalId
      );
    }

    // Replace the association
    const response = await this.ec2Client.send(
      new ReplaceNetworkAclAssociationCommand({
        AssociationId: currentAssociationId,
        NetworkAclId: networkAclId,
      })
    );

    const newAssociationId = response.NewAssociationId!;
    this.logger.debug(
      `Successfully created SubnetNetworkAclAssociation ${logicalId}: ${newAssociationId}`
    );

    return {
      physicalId: newAssociationId,
      attributes: {
        AssociationId: newAssociationId,
      },
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create SubnetNetworkAclAssociation ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const networkAclMethods = {
  createNetworkAcl,
  deleteNetworkAcl,
  createNetworkAclEntry,
  deleteNetworkAclEntry,
  updateNetworkAclEntry,
  createSubnetNetworkAclAssociation,
};
