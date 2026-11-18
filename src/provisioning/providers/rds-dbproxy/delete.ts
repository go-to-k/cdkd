import type { RDSDBProxyProvider } from '../rds-dbproxy-provider.js';
import {
  DeleteDBProxyCommand,
  DescribeDBProxiesCommand,
  DBProxyNotFoundFault,
} from '@aws-sdk/client-rds';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { waitForDBProxyDeleteGone } from './shared.js';

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

  this.logger.debug(mask(`Deleting DBProxy ${physicalId}`));

  try {
    await client.send(new DeleteDBProxyCommand({ DBProxyName: physicalId }));
  } catch (error) {
    if (error instanceof DBProxyNotFoundFault) {
      const clientRegion = await client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(mask(`DBProxy ${physicalId} already gone, treating as success`));
      return;
    }
    throw this.wrapDeleteError(error, 'DELETE', resourceType, logicalId, physicalId, mask);
  }

  // Wait for the proxy to fully disappear. AWS keeps the resource in
  // `deleting` state for ~30-60s before DescribeDBProxies starts
  // returning DBProxyNotFoundFault — without this wait, a subsequent
  // `cdkd deploy` of a same-named proxy can race AWS's eventual delete.
  // Outside the try: the wait's only throw is its own marked error.
  await waitForDBProxyDeleteGone({
    what: `DBProxy ${physicalId}`,
    resourceType,
    logicalId,
    physicalId,
    readStatus: async () => {
      try {
        const out = await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
        return out.DBProxies?.[0]?.Status ?? 'unknown';
      } catch (error) {
        if (error instanceof DBProxyNotFoundFault) return undefined;
        throw error;
      }
    },
    logger: this.logger,
    mask,
  });
}
