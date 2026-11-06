import type { RDSDBProxyProvider } from '../rds-dbproxy-provider.js';
import {
  CreateDBProxyCommand,
  DescribeDBProxiesCommand,
  DBProxyNotFoundFault,
  type UserAuthConfig,
  type DefaultAuthScheme,
  type EndpointNetworkType,
  type EngineFamily,
  type TargetConnectionNetworkType,
} from '@aws-sdk/client-rds';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import {
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../../tag-list.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { definedAttributes } from '../../attribute-map.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, authRequired } from './shared.js';

export async function create(
  this: RDSDBProxyProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    undefined,
    'Tags',
    DBPROXY_TAGS_WHAT,
    DBPROXY_TAG_OPTIONS
  );
  const dbProxyName =
    (properties['DBProxyName'] as string | undefined) ??
    generatedNameFor('AWS::RDS::DBProxy', logicalId);
  const engineFamily = properties['EngineFamily'] as EngineFamily | undefined;
  if (!engineFamily) {
    throw new ProvisioningError(
      `EngineFamily is required for AWS::RDS::DBProxy ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  const auth = properties['Auth'] as UserAuthConfig[] | undefined;
  if ((!auth || auth.length === 0) && authRequired(properties)) {
    throw new ProvisioningError(
      `Auth (at least one entry) is required for AWS::RDS::DBProxy ${logicalId} while DefaultAuthScheme is NONE or unset`,
      resourceType,
      logicalId
    );
  }
  const roleArn = properties['RoleArn'] as string | undefined;
  if (!roleArn) {
    throw new ProvisioningError(
      `RoleArn is required for AWS::RDS::DBProxy ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  const vpcSubnetIds = properties['VpcSubnetIds'] as string[] | undefined;
  if (!vpcSubnetIds || vpcSubnetIds.length === 0) {
    throw new ProvisioningError(
      `VpcSubnetIds (at least one) is required for AWS::RDS::DBProxy ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const client = this.getClient();

  this.logger.debug(mask(`Creating DBProxy ${dbProxyName} (${engineFamily})`));

  try {
    await this.getCreateClient().send(
      new CreateDBProxyCommand({
        DBProxyName: dbProxyName,
        EngineFamily: engineFamily,
        Auth: auth && auth.length > 0 ? auth : undefined,
        DefaultAuthScheme: properties['DefaultAuthScheme'] as DefaultAuthScheme | undefined,
        EndpointNetworkType: properties['EndpointNetworkType'] as EndpointNetworkType | undefined,
        TargetConnectionNetworkType: properties['TargetConnectionNetworkType'] as
          | TargetConnectionNetworkType
          | undefined,
        RoleArn: roleArn,
        VpcSubnetIds: vpcSubnetIds,
        VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
        RequireTLS: properties['RequireTLS'] as boolean | undefined,
        IdleClientTimeout: properties['IdleClientTimeout'] as number | undefined,
        DebugLogging: properties['DebugLogging'] as boolean | undefined,
        Tags: tags.length > 0 ? tags : undefined,
      })
    );
  } catch (error) {
    throw this.wrapCaughtError(error, 'CREATE', resourceType, logicalId, undefined, mask);
  }
  // go-to-k/cdkd#5511: reported before the available poll.
  reportCreatedResource(logicalId, resourceType, dbProxyName);

  // Wait until DBProxyStatus = 'available'. Post-create wiring (Targets via
  // RDSDBProxyTargetGroupProvider.create()) requires the proxy to be
  // available, so blocking here keeps the deploy engine's DAG consistent.
  let endpoint: string | undefined;
  let dbProxyArn: string | undefined;
  let vpcId: string | undefined;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status: string | undefined;
  try {
    while (Date.now() < deadline) {
      try {
        const describe = await client.send(
          new DescribeDBProxiesCommand({ DBProxyName: dbProxyName })
        );
        const proxy = describe.DBProxies?.[0];
        status = proxy?.Status;
        if (status === 'available') {
          endpoint = proxy?.Endpoint;
          dbProxyArn = proxy?.DBProxyArn;
          vpcId = proxy?.VpcId;
          break;
        }
        if (status === 'incompatible-network' || status === 'insufficient-resource-limits') {
          throw new ProvisioningError(
            mask(`DBProxy ${dbProxyName} entered terminal failure state: ${status}`),
            resourceType,
            logicalId,
            dbProxyName
          );
        }
      } catch (error) {
        if (error instanceof DBProxyNotFoundFault) {
          // Not yet visible — keep polling.
        } else if (error instanceof ProvisioningError) {
          throw error;
        } else {
          throw this.wrapCaughtError(
            error,
            'CREATE (poll)',
            resourceType,
            logicalId,
            dbProxyName,
            mask
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!endpoint || !dbProxyArn) {
      throw new ProvisioningError(
        mask(
          `Timed out waiting for DBProxy ${dbProxyName} to become available (last status: ${status ?? 'unknown'})`
        ),
        resourceType,
        logicalId,
        dbProxyName
      );
    }
  } catch (error) {
    // go-to-k/cdkd#4583: CreateDBProxy returned, so the proxy exists under
    // `dbProxyName` (the id delete() takes); name it for --revert-failed.
    markCreatedBeforeFailure(error, logicalId, resourceType, dbProxyName);
    throw error;
  }

  return {
    physicalId: dbProxyName,
    attributes: definedAttributes({
      DBProxyArn: dbProxyArn,
      Endpoint: endpoint,
      VpcId: vpcId,
    }),
  };
}
