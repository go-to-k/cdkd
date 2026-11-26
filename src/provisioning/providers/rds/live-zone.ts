import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';

/**
 * go-to-k/cdkd#7057: the zone a DB instance runs in, read with ONE
 * `DescribeDBInstances` by its identifier in `region`, through a client built
 * as `RDSProvider.getClient` builds its own (the ambient identity, the named
 * region). `undefined` when the answer names no zone, or names another
 * instance than the one asked about; a failed call rejects.
 */
export async function readDbInstanceAvailabilityZone(
  identifier: string,
  region: string,
  client: RDSClient = new RDSClient({ ...ambientClientDefaults(), region })
): Promise<string | undefined> {
  const response = await client.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })
  );
  const instance = response.DBInstances?.[0];
  // RDS stores the identifier lowercased and matches it case-insensitively.
  if (instance?.DBInstanceIdentifier?.toLowerCase() !== identifier.toLowerCase()) return undefined;
  const zone = instance.AvailabilityZone;
  return typeof zone === 'string' && zone !== '' ? zone : undefined;
}
