import {
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBSubnetGroupCommand,
} from '@aws-sdk/client-rds';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { generatedNameFor } from '../../resource-name.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { RDSProvider } from '../rds-provider.js';

// ─── DBSubnetGroup ────────────────────────────────────────────────

export async function createDBSubnetGroup(
  this: RDSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating DBSubnetGroup ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const dbSubnetGroupName =
    (properties['DBSubnetGroupName'] as string | undefined) ||
    generatedNameFor('AWS::RDS::DBSubnetGroup', logicalId);

  try {
    const created = await this.getCreateClient().send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: dbSubnetGroupName,
        DBSubnetGroupDescription:
          (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
        SubnetIds: properties['SubnetIds'] as string[],
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    this.logger.debug(`Successfully created DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`);

    // `DBSubnetGroupArn` read straight off the create response (issue #1824).
    // AWS added the attribute to the CFn schema after the 2026-05-16 fixture
    // capture, and an output / cross-resource `Fn::GetAtt` reads the CACHED
    // `resource.attributes[<CFnName>]` in
    // `constructAttribute` (`deployment/intrinsic-resolver/getatt.ts`) — which never calls a
    // provider's `getAttribute` — so an uncached `*Arn` name HARD-FAILS the
    // resolver's shape guard against this type's name-shaped physicalId.
    // `CreateDBSubnetGroup` reports the ARN directly, so this needs no extra
    // API call and no construction: it is the value AWS holds.
    const dbSubnetGroupArn = created.DBSubnetGroup?.DBSubnetGroupArn;

    return {
      physicalId: dbSubnetGroupName,
      attributes: {
        DBSubnetGroupName: dbSubnetGroupName,
        // Spread CONDITIONALLY rather than writing `undefined`: a
        // present-but-undefined key survives `structuredClone` into the state
        // record, so every `Object.keys` consumer sees a key carrying nothing.
        ...(dbSubnetGroupArn !== undefined && { DBSubnetGroupArn: dbSubnetGroupArn }),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create DBSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          dbSubnetGroupName,
          cause
        )
    );
  }
}

export async function updateDBSubnetGroup(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating DBSubnetGroup ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // Class 2 — `SubnetIds: []` would be rejected by AWS as a structurally
    // invalid input (DBSubnetGroup requires ≥ 2 subnets in distinct AZs).
    // readCurrentState emits `SubnetIds: []` as a placeholder when AWS
    // happens to return no subnets; the round-trip must NOT translate
    // that into a malformed SDK call. Skip the field when empty so the
    // ModifyDBSubnetGroup call is a no-op for the subnet list.
    const subnetIds = properties['SubnetIds'] as string[] | undefined;
    const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
    // The SDK input type marks `SubnetIds` as required; a description-
    // only update is a legitimate use case that omits the field on the
    // wire (AWS supports it). Cast the input shape to bypass the
    // type-level requirement.
    const modifyInput = {
      DBSubnetGroupName: physicalId,
      DBSubnetGroupDescription: properties['DBSubnetGroupDescription'] as string | undefined,
      ...(sendSubnetIds && { SubnetIds: subnetIds }),
    } as ConstructorParameters<typeof ModifyDBSubnetGroupCommand>[0];
    await this.getClient().send(new ModifyDBSubnetGroupCommand(modifyInput));

    // Apply tag diff. RDS uses ARN-keyed AddTagsToResource /
    // RemoveTagsFromResource. DescribeDBSubnetGroups returns the ARN.
    const desc = await this.getClient().send(
      new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
    );
    const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
    if (arn) {
      await this.applyTagDiff(
        arn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );
    }

    this.logger.debug(`Successfully updated DBSubnetGroup ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        DBSubnetGroupName: physicalId,
        // Re-report `DBSubnetGroupArn` here even though an in-place update
        // cannot change it (issue #1824): an update result's `attributes`
        // REPLACE the state record's rather than merging into it, so
        // returning only `DBSubnetGroupName` would WIPE the ARN recorded at
        // create time and re-break the `Fn::GetAtt` the create-side fix
        // repairs. The value is free — the `DescribeDBSubnetGroups` above
        // already ran to key the tag diff.
        //
        // When AWS reports no ARN (or reports no group at all) the key is
        // DROPPED rather than written empty, and the reason is NOT the one the
        // SSM sibling gives (issue #1824 review round 3 corrected this). There
        // the rejected alternative — returning NO attributes, so the engine's
        // `result.attributes ?? ...` carries the PREVIOUS map forward — would
        // answer `Fn::GetAtt` from a SUPERSEDED value, because that map holds
        // the `Type` / `Value` this update just changed. Nothing here can be
        // superseded: the only other key is `DBSubnetGroupName`, which IS the
        // physicalId, and an in-place `ModifyDBSubnetGroup` cannot rename it
        // (`wasReplaced: false`), so a carried-forward value would be
        // byte-identical.
        //
        // What decides it instead is that the carry-forward makes the record's
        // contents depend on the shape of whatever map happened to be there
        // before, and after an `import()` that map holds the ARN ALONE (see
        // this provider's `importDBSubnetGroup`) — so it would DROP the one
        // key this update can state authoritatively rather than supersede
        // anything. Returning the partial map always records exactly what this
        // update observed, and degrades to the resolver's LOUD `*Arn`
        // shape-guard failure. It heals on the resource's next UPDATE, or
        // on the next deploy that resolves a `Fn::GetAtt` on it: a plain
        // re-deploy skips the provider, so the deploy engine re-reads the
        // record through `import()` on that miss (issue
        // https://github.com/go-to-k/cdkd/issues/1852).
        ...(arn !== undefined && { DBSubnetGroupArn: arn }),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update DBSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteDBSubnetGroup(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting DBSubnetGroup ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteDBSubnetGroupCommand({
        DBSubnetGroupName: physicalId,
      })
    );
    this.logger.debug(`Successfully deleted DBSubnetGroup ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DBSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function readCurrentStateDBSubnetGroup(
  this: RDSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp: {
    DBSubnetGroups?: Array<{
      DBSubnetGroupName?: string;
      DBSubnetGroupArn?: string;
      DBSubnetGroupDescription?: string;
      Subnets?: Array<{ SubnetIdentifier?: string }>;
    }>;
  };
  try {
    resp = (await this.getClient().send(
      new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
    )) as unknown as typeof resp;
  } catch (err) {
    // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
    // the looser message match keeps its old "cannot tell" answer.
    if ((err as { name?: unknown } | null)?.name === 'DBSubnetGroupNotFoundFault')
      return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
    throw err;
  }
  const sg = resp.DBSubnetGroups?.[0];
  if (!sg) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (sg.DBSubnetGroupName !== undefined) result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
  if (sg.DBSubnetGroupDescription !== undefined) {
    result['DBSubnetGroupDescription'] = sg.DBSubnetGroupDescription;
  }
  result['SubnetIds'] = (sg.Subnets ?? [])
    .map((s) => s.SubnetIdentifier)
    .filter((id): id is string => !!id);
  if (sg.DBSubnetGroupArn) await this.attachTags(result, sg.DBSubnetGroupArn);
  return result;
}

export async function importDBSubnetGroup(
  this: RDSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
  if (explicit) {
    try {
      const desc = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
      );
      // Record `DBSubnetGroupArn` on the import path too (issue #1824): the
      // state record an import writes is what a later `Fn::GetAtt` reads, so
      // leaving it empty left an ADOPTED subnet group hitting the same
      // resolver shape-guard hard-fail the create-side fix repairs. Free —
      // the existence-verification Describe above already reports the ARN.
      const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
      return {
        physicalId: explicit,
        attributes: { ...(arn !== undefined && { DBSubnetGroupArn: arn }) },
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
      throw err;
    }
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB subnet group reaching here needs an explicit `--resource` override.
  return null;
}
