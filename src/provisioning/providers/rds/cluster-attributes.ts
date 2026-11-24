import type { DBCluster } from '@aws-sdk/client-rds';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { EXPRESS_WRITER_RESOURCE_ID_KEY } from './express-writer.js';

/** What a writer records beside the described cluster. */
export interface DbClusterAttributeExtras {
  /** The port to record instead of the described one (a `--no-wait` port change). */
  readonly port?: number | undefined;
  /** go-to-k/cdkd#5984: the express writer's resource id, cdkd's own key. */
  readonly expressWriterId?: string | undefined;
}

/**
 * The `Fn::GetAtt` attributes an RDS DB cluster records, from a
 * `DescribeDBClusters` cluster: every writer of the record (create, update,
 * `import()`, the Cloud Control route's enrichment) builds it here, so the key
 * sets cannot drift apart — `attributes` REPLACES the record on update.
 *
 * The whole `Endpoint` (`{Address, Port}`) and `ReadEndpoint` (`{Address}`)
 * objects CloudFormation serves are not recorded a second time
 * (go-to-k/cdkd#6242): the resolver assembles them from these flat members,
 * so an object and its members cannot disagree, and a record written before
 * the change serves them too. `StorageEncryptionType` is recorded as RDS
 * reports it (`sse-kms`), absent when it reports none.
 *
 * go-to-k/cdkd#6913: `MasterUserSecret.SecretArn` (CDK's
 * `attrMasterUserSecretSecretArn`, which the L2's `secret` reads under
 * `manageMasterUserPassword`) is absent when RDS manages no master secret,
 * and `StorageThroughput` when RDS reports none.
 */
export function dbClusterAttributes(
  cluster: DBCluster | undefined,
  extras: DbClusterAttributeExtras = {}
): Record<string, unknown> {
  return definedAttributes({
    'Endpoint.Address': cluster?.Endpoint,
    'Endpoint.Port': stringifyIfAssigned(
      cluster !== undefined && extras.port !== undefined ? extras.port : cluster?.Port
    ),
    'ReadEndpoint.Address': cluster?.ReaderEndpoint,
    Arn: cluster?.DBClusterArn,
    DBClusterResourceId: cluster?.DbClusterResourceId,
    StorageEncryptionType: cluster?.StorageEncryptionType,
    StorageThroughput: cluster?.StorageThroughput,
    'MasterUserSecret.SecretArn': cluster?.MasterUserSecret?.SecretArn,
    [EXPRESS_WRITER_RESOURCE_ID_KEY]: extras.expressWriterId,
  });
}
