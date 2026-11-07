import type { RDSDBProxyTargetGroupProvider } from '../rds-dbproxy-targetgroup-provider.js';
import {
  RegisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
  ModifyDBProxyTargetGroupCommand,
  AddTagsToResourceCommand,
} from '@aws-sdk/client-rds';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { replayWarn, requireConfigString } from '../../config-shape.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markAuxiliaryFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import {
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
  readTagList,
  refuseMalformedDesiredTags,
} from '../../tag-list.js';
import { readTargetLists, readProxyName, withoutKey } from './shared.js';

export async function create(
  this: RDSDBProxyTargetGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const dbProxyName = readProxyName(properties['DBProxyName']);
  if (!dbProxyName) {
    throw new ProvisioningError(
      `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  const targetGroupName = requireConfigString(
    properties['TargetGroupName'],
    'default',
    'AWS::RDS::DBProxyTargetGroup TargetGroupName',
    replayWarn(this.logger, context)
  );
  // go-to-k/cdkd#3945: refused before any call, the pool config included — a
  // rollback's reverse-replacement create replays a state record here too.
  const targets = readTargetLists({
    DBClusterIdentifiers: properties['DBClusterIdentifiers'],
    DBInstanceIdentifiers: properties['DBInstanceIdentifiers'],
  });
  if (targets.malformed.length > 0) {
    throw new ProvisioningError(
      `${targets.malformed.join(' / ')} of AWS::RDS::DBProxyTargetGroup ${logicalId} is not a ` +
        `list of RDS DB identifiers — no target registered`,
      resourceType,
      logicalId
    );
  }
  const dbClusterIdentifiers = targets.lists.DBClusterIdentifiers;
  const dbInstanceIdentifiers = targets.lists.DBInstanceIdentifiers;
  const connectionPoolConfig = properties['ConnectionPoolConfigurationInfo'] as
    | Record<string, unknown>
    | undefined;
  const mask = context?.maskSecrets ?? ((t: string) => t);
  // Refused before the first call: a malformed list would otherwise surface
  // only after the targets are registered. A state replay cannot fix its
  // record from the template, so there it warns and skips tagging, and the
  // key is dropped from what gets recorded.
  const desiredRead = readTagList(properties['Tags'], 'desired', DBPROXY_TAG_OPTIONS);
  const skipTags = context?.replayingState === true && desiredRead.kind === 'malformed';
  if (skipTags) {
    const reason = desiredRead.secretDerived
      ? 'holds a dynamic reference or its mask where a tag key belongs'
      : `is not ${DBPROXY_TAGS_WHAT}`;
    this.logger.warn(
      safeMsg`${logicalId}: the recorded Tags ${reason}; re-creating the target group without tags.`
    );
  }
  const tags = skipTags
    ? []
    : refuseMalformedDesiredTags(
        properties['Tags'],
        resourceType,
        logicalId,
        undefined,
        'Tags',
        DBPROXY_TAGS_WHAT,
        DBPROXY_TAG_OPTIONS
      );

  const client = this.getClient();

  if (connectionPoolConfig) {
    this.logger.debug(mask(`Applying connection pool config to ${dbProxyName}/${targetGroupName}`));
    try {
      await client.send(
        new ModifyDBProxyTargetGroupCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          ConnectionPoolConfig: connectionPoolConfig as never,
        })
      );
    } catch (error) {
      // An adjustment of the proxy's own target group, not the registration
      // this resource creates: never this resource's collision (#3826).
      // Marked BEFORE the wrap, so the wrap does not restate the collision.
      throw this.wrapError(
        markAuxiliaryFailure(error, logicalId),
        'CREATE (pool config)',
        resourceType,
        logicalId,
        undefined,
        mask
      );
    }
  }

  if (dbClusterIdentifiers.length > 0 || dbInstanceIdentifiers.length > 0) {
    this.logger.debug(
      mask(
        `Registering targets for ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${dbClusterIdentifiers.map(mask).join(',')}], ` +
          `instances=[${dbInstanceIdentifiers.map(mask).join(',')}]`
      )
    );
    try {
      await client.send(
        new RegisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: dbClusterIdentifiers.length > 0 ? dbClusterIdentifiers : undefined,
          DBInstanceIdentifiers:
            dbInstanceIdentifiers.length > 0 ? dbInstanceIdentifiers : undefined,
        })
      );
    } catch (error) {
      throw this.wrapError(
        error,
        'CREATE (register targets)',
        resourceType,
        logicalId,
        undefined,
        mask
      );
    }
  }

  let targetGroupArn: string | undefined;
  try {
    const describeResponse = await client.send(
      new DescribeDBProxyTargetGroupsCommand({
        DBProxyName: dbProxyName,
        TargetGroupName: targetGroupName,
      })
    );
    targetGroupArn = describeResponse.TargetGroups?.[0]?.TargetGroupArn;
  } catch (error) {
    // Every throw from here on leaves the registration above live with
    // nothing recorded, so each retires it first.
    throw await this.retireRegistrationAfterFailedCreate(
      this.wrapError(error, 'CREATE (describe)', resourceType, logicalId, undefined, mask),
      dbProxyName,
      targetGroupName,
      dbClusterIdentifiers,
      dbInstanceIdentifiers,
      context?.maskSecrets
    );
  }

  if (!targetGroupArn) {
    throw await this.retireRegistrationAfterFailedCreate(
      new ProvisioningError(
        `Failed to recover TargetGroupArn for ${dbProxyName}/${targetGroupName} after create`,
        resourceType,
        logicalId
      ),
      dbProxyName,
      targetGroupName,
      dbClusterIdentifiers,
      dbInstanceIdentifiers,
      context?.maskSecrets
    );
  }

  // go-to-k/cdkd#5511: the id the mark uses is known only here, after the
  // describe; reported before the tagging call, when targets were registered.
  if (dbClusterIdentifiers.length > 0 || dbInstanceIdentifiers.length > 0) {
    reportCreatedResource(logicalId, resourceType, targetGroupArn);
  }

  if (tags.length > 0) {
    try {
      await client.send(
        new AddTagsToResourceCommand({
          ResourceName: targetGroupArn,
          Tags: tags,
        })
      );
    } catch (error) {
      throw await this.retireRegistrationAfterFailedCreate(
        this.wrapError(error, 'CREATE (add tags)', resourceType, logicalId, undefined, mask),
        dbProxyName,
        targetGroupName,
        dbClusterIdentifiers,
        dbInstanceIdentifiers,
        context?.maskSecrets,
        // go-to-k/cdkd#4583: the ARN is known here (the id delete() takes),
        // so a registration the deregister could not retire is journaled.
        { logicalId, resourceType, physicalId: targetGroupArn }
      );
    }
  }

  return {
    physicalId: targetGroupArn,
    attributes: {
      TargetGroupArn: targetGroupArn,
      TargetGroupName: targetGroupName,
    },
    ...(skipTags && { effectiveProperties: withoutKey(properties, 'Tags') }),
  };
}
