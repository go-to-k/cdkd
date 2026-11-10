import { DeleteDBInstanceCommand, type DBCluster } from '@aws-sdk/client-rds';
import { safeMsg } from '../../../utils/display-safe.js';
import type { RDSProvider } from '../rds-provider.js';
import { httpEndpointFlag } from './cluster-members.js';

/**
 * go-to-k/cdkd#5984: a DBCluster created `WithExpressConfiguration` gets a
 * writer instance RDS creates itself, `<cluster>-instance-1` (`db.serverless`),
 * which no template declares. RDS refuses `DeleteDBCluster` while it exists, so
 * the cluster's delete removes it first, as CloudFormation's delete handler does
 * (`DeleteDBInstance` on that name, `SkipFinalSnapshot: true`, measured via
 * CloudTrail, us-east-1, 2026-11-10). That handler deletes no other member: a
 * cluster still holding one ends `DELETE_FAILED`.
 *
 * The attribute key under which cdkd records that writer's `DbiResourceId`
 * at create, so the delete removes the instance RDS made and not one a user
 * created later under the same name. Not a CloudFormation attribute: no
 * template can `Fn::GetAtt` it, and no CloudFormation name contains `:`.
 */
export const EXPRESS_WRITER_RESOURCE_ID_KEY = 'cdkd:ExpressWriterResourceId';

/**
 * A refusal {@link deleteExpressWriter} raises before any delete; the cluster
 * delete wraps it, not gone and non-retryable.
 */
export class ExpressWriterRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressWriterRefusal';
  }
}

/** The writer RDS creates for an express-configuration cluster. */
export function expressWriterIdentifier(dbClusterIdentifier: string): string {
  return `${dbClusterIdentifier}-instance-1`;
}

/**
 * The `WithExpressConfiguration` flag as CloudFormation reads it: `true` /
 * `'true'`, `false` / `'false'`, absent, or `'malformed'`.
 */
export function expressConfigurationFlag(value: unknown): boolean | undefined | 'malformed' {
  return httpEndpointFlag(value);
}

/** The recorded writer id, or `undefined` when the record holds none. */
export function recordedExpressWriterId(
  attributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const value = attributes?.[EXPRESS_WRITER_RESOURCE_ID_KEY];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The express writer's `DbiResourceId`, read right after the create (RDS
 * reports the writer from the `CreateDBCluster` response on), or `undefined`
 * when it cannot be read: the delete then falls back to the name, as
 * CloudFormation's does.
 */
export async function readExpressWriterId(
  this: RDSProvider,
  dbClusterIdentifier: string
): Promise<string | undefined> {
  try {
    const writer = await this.describeDBInstance(expressWriterIdentifier(dbClusterIdentifier));
    return writer?.DBClusterIdentifier === dbClusterIdentifier ? writer.DbiResourceId : undefined;
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not read the express writer of DBCluster ${dbClusterIdentifier}: ${error instanceof Error ? error.name : 'unknown error'}`
    );
    return undefined;
  }
}

/**
 * Before `DeleteDBCluster`, delete the writer RDS created for an express
 * cluster. Returns whether a delete was sent. RDS takes the cluster delete
 * once the writer is `deleting` (measured, us-east-1, 2026-11-10), so the
 * caller does not wait for the writer to be gone.
 *
 * Nothing is deleted, and the cluster delete that follows reports AWS's
 * answer, when the cluster is gone, has deletion protection on (the cluster
 * delete would fail anyway, so the writer is kept; unless this run's
 * `--remove-protection` turned it off, which the read can still lag), or no
 * longer has the writer. Refused, before any delete, when another member is not already
 * `deleting` (RDS would then refuse the cluster delete with the writer gone)
 * or when the instance under the writer's name is not the one recorded at
 * create.
 */
export async function deleteExpressWriter(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  cluster: DBCluster | undefined,
  recordedWriterId: string | undefined,
  protectionFlippedOff = false
): Promise<boolean> {
  if (cluster === undefined) return false;
  if (cluster.DeletionProtection === true && !protectionFlippedOff) return false;
  const writerName = expressWriterIdentifier(physicalId);
  const members = cluster.DBClusterMembers ?? [];
  if (!members.some((member) => member.DBInstanceIdentifier === writerName)) return false;

  const refuse = (detail: string): never => {
    throw new ExpressWriterRefusal(detail);
  };

  const others: string[] = [];
  for (const member of members) {
    const name = member.DBInstanceIdentifier;
    if (name === undefined || name === writerName) continue;
    const instance = await this.describeDBInstance(name).catch((error: unknown) => {
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return undefined;
      throw error;
    });
    if (instance !== undefined && instance.DBInstanceStatus !== 'deleting') others.push(name);
  }
  if (others.length > 0) {
    refuse(
      safeMsg`it still has DB instance(s) ${others.join(', ')} besides the writer express configuration created; delete them first, then re-run`
    );
  }

  if (recordedWriterId !== undefined) {
    const writer = await this.describeDBInstance(writerName).catch((error: unknown) => {
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return undefined;
      throw error;
    });
    if (writer === undefined) return false;
    if (writer.DbiResourceId !== recordedWriterId) {
      refuse(
        safeMsg`DB instance ${writerName} is not the writer express configuration created for it, so cdkd did not delete it; delete it yourself, then re-run`
      );
    }
  }

  try {
    await this.getClient().send(
      new DeleteDBInstanceCommand({ DBInstanceIdentifier: writerName, SkipFinalSnapshot: true })
    );
  } catch (error) {
    // Already gone, or already on its way out: the cluster delete goes ahead.
    if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return false;
    if (error instanceof Error && error.name === 'InvalidDBInstanceStateFault') {
      const state = await this.describeDBInstance(writerName).catch(() => undefined);
      if (state?.DBInstanceStatus === 'deleting') return true;
    }
    throw error;
  }
  this.logger.debug(safeMsg`Deleted the express writer ${writerName} of DBCluster ${logicalId}`);
  return true;
}
