import type { RDSDBProxyProvider } from '../rds-dbproxy-provider.js';
import {
  DeleteDBProxyCommand,
  DescribeDBProxiesCommand,
  DBProxyNotFoundFault,
} from '@aws-sdk/client-rds';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from './shared.js';

export async function deleteImpl(
  this: RDSDBProxyProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  const client = this.getClient();
  const mask = maskerOrIdentity(context?.maskSecrets);

  this.logger.debug(`Deleting DBProxy ${physicalId}`);

  try {
    await client.send(new DeleteDBProxyCommand({ DBProxyName: physicalId }));
  } catch (error) {
    if (error instanceof DBProxyNotFoundFault) {
      const clientRegion = await client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`DBProxy ${physicalId} already gone, treating as success`);
      return;
    }
    throw this.wrapDeleteError(error, 'DELETE', resourceType, logicalId, physicalId, mask);
  }

  // Wait for the proxy to fully disappear. AWS keeps the resource in
  // `deleting` state for ~30-60s before DescribeDBProxies starts
  // returning DBProxyNotFoundFault — without this wait, a subsequent
  // `cdkd deploy` of a same-named proxy can race AWS's eventual delete.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) {
        this.logger.debug(`DBProxy ${physicalId} fully deleted`);
        return;
      }
      throw this.wrapDeleteError(error, 'DELETE (poll)', resourceType, logicalId, physicalId, mask);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new ProvisioningError(
    `Timed out waiting for DBProxy ${physicalId} to fully delete`,
    resourceType,
    logicalId,
    physicalId
  );
}
