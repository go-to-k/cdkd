import { safeMsg } from '../utils/display-safe.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { RESOURCE_NOT_FOUND, type ResourceProvider } from '../types/resource.js';
import { markNonRetryable } from './retryable-errors.js';

/** What {@link verifyRestoreSourceIdentity} needs about the cluster a replacement deletes first. */
export interface RestoreSourceIdentityInput {
  /** The TEMPLATE's type: the one whose create restores. */
  resourceType: string;
  logicalId: string;
  /** The replaced cluster's physical id (its name). */
  physicalId: string;
  /** The replacement's resolved properties. */
  properties: Record<string, unknown>;
  /** The replaced record's attributes. */
  attributes: Record<string, unknown> | undefined;
  stackName: string;
  region: string;
  /** The type's registered provider, read only when the check needs it. */
  provider: () => ResourceProvider | undefined;
}

/**
 * go-to-k/cdkd#5639: a delete-first replacement of an `AWS::RDS::DBCluster`
 * whose new `SourceDbClusterResourceId` may be the cluster it is about to
 * delete. `refuseRestoreFromItself` compares the record's `DBClusterResourceId`;
 * a record without one (an older import, or a create whose read-back had none)
 * would pass it, the delete would take the cluster and its automated backups,
 * and the restore would then find nothing. So for that shape only, the live
 * cluster's resource id is read through the provider's read-only `import()`
 * (`DescribeDBClusters` by name) and compared; a read that fails or answers no
 * id refuses too, since the delete cannot be undone. Any other type, a
 * template without the key, or a record holding its id costs no call.
 *
 * Not called by the rollback's reverse-replacement delete: there the OLD
 * record's source is compared with the NEWER cluster, whose resource id did
 * not exist when that record was written.
 */
export async function verifyRestoreSourceIdentity(
  input: RestoreSourceIdentityInput
): Promise<void> {
  if (input.resourceType === 'AWS::RDS::DBInstance') {
    await verifyInstancePointInTimeSource(input);
    return;
  }
  if (input.resourceType !== 'AWS::RDS::DBCluster') return;
  const source = input.properties['SourceDbClusterResourceId'];
  if (typeof source !== 'string' || source === '') return;
  const recorded = input.attributes?.['DBClusterResourceId'];
  if (typeof recorded === 'string' && recorded !== '') return;
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${input.resourceType} ${input.logicalId}: ${reason}; nothing was changed.`,
        input.resourceType,
        input.logicalId,
        input.physicalId
      )
    );
  };
  let liveId: unknown;
  let failure = '';
  try {
    const provider = input.provider();
    if (provider?.import === undefined) {
      failure = 'no provider can read it';
    } else {
      const result = await provider.import({
        logicalId: input.logicalId,
        resourceType: input.resourceType,
        stackName: input.stackName,
        region: input.region,
        properties: {},
        knownPhysicalId: input.physicalId,
      });
      liveId = result?.attributes?.['DBClusterResourceId'];
      if (result === null) failure = 'it was not found';
    }
  } catch (error) {
    // The error class only: AWS's text can name the account and role.
    failure = `the read failed (${(error as { name?: string } | undefined)?.name ?? 'Error'})`;
  }
  if (typeof liveId !== 'string' || liveId === '') {
    return refuse(
      `SourceDbClusterResourceId may name the cluster this replacement deletes first, and its identity could not be verified (${failure || 'no resource id was read'}). Name the source with SourceDBClusterIdentifier instead, or retry`
    );
  }
  if (liveId.toLowerCase() === source.toLowerCase()) {
    refuse("SourceDbClusterResourceId must be another cluster's than the one this replaces");
  }
}

/**
 * go-to-k/cdkd#5640: the DB instance's twin. A point-in-time restore naming
 * its source by `SourceDbiResourceId` or `SourceDBInstanceAutomatedBackupsArn`
 * (either key makes the create one) may name the instance the replacement
 * deletes first, which takes its automated backups with it
 * (`DeleteAutomatedBackups` defaults to true). Through the provider's
 * read-only `resourceIdentity`: the replaced instance's `DbiResourceId` (the
 * record holds none, so it is read live by name unless recorded), and, for a
 * backups ARN in this region, the `DbiResourceId` of the instance that backup
 * belongs to (`DescribeDBInstanceAutomatedBackups`; a backup RDS does not list
 * is none of this instance's). A read that fails or answers no id refuses, as
 * does a replaced instance that is not found, since the delete cannot be
 * undone. A template naming neither key costs no call.
 */
async function verifyInstancePointInTimeSource(input: RestoreSourceIdentityInput): Promise<void> {
  const nonEmpty = (key: string): string | undefined => {
    const value = input.properties[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const resourceId = nonEmpty('SourceDbiResourceId');
  // An ARN of another region holds another region's backups: not this instance's.
  const declaredBackups = nonEmpty('SourceDBInstanceAutomatedBackupsArn');
  const backupsRegion = declaredBackups?.split(':')[3];
  const backups =
    declaredBackups !== undefined &&
    (backupsRegion === undefined || backupsRegion === '' || backupsRegion === input.region)
      ? declaredBackups
      : undefined;
  if (resourceId === undefined && backups === undefined) return;
  const recorded = input.attributes?.['DbiResourceId'];
  // `refuseRestoreFromItself` compared a recorded id with `SourceDbiResourceId`.
  if (backups === undefined && typeof recorded === 'string' && recorded !== '') return;
  const key = backups !== undefined ? 'SourceDBInstanceAutomatedBackupsArn' : 'SourceDbiResourceId';
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${input.resourceType} ${input.logicalId}: ${reason}; nothing was changed.`,
        input.resourceType,
        input.logicalId,
        input.physicalId
      )
    );
  };
  const unverified = (failure: string): never =>
    refuse(
      `${key} may name the DB instance this replacement deletes first, and its identity could not be verified (${failure}). Name the source with SourceDBInstanceIdentifier instead, or retry`
    );
  const provider = input.provider();
  if (provider?.resourceIdentity === undefined) return unverified('no provider can read it');
  const read = provider.resourceIdentity.bind(provider);
  const identity = async (id: string): Promise<string | typeof RESOURCE_NOT_FOUND> => {
    let answer: string | typeof RESOURCE_NOT_FOUND | undefined;
    try {
      answer = await read(id, input.resourceType, { expectedRegion: input.region });
    } catch (error) {
      // The error class only: AWS's text can name the account and role.
      return unverified(
        `the read failed (${(error as { name?: string } | undefined)?.name ?? 'Error'})`
      );
    }
    if (answer === undefined || answer === '') return unverified('no resource id was read');
    return answer;
  };
  let own = typeof recorded === 'string' && recorded !== '' ? recorded : undefined;
  if (own === undefined) {
    const live = await identity(input.physicalId);
    if (live === RESOURCE_NOT_FOUND) return unverified('it was not found');
    own = live;
  }
  if (resourceId !== undefined && resourceId.toLowerCase() === own.toLowerCase()) {
    refuse("SourceDbiResourceId must be another DB instance's than the one this replaces");
  }
  if (backups !== undefined) {
    const owner = await identity(backups);
    if (owner !== RESOURCE_NOT_FOUND && owner.toLowerCase() === own.toLowerCase()) {
      refuse(
        "SourceDBInstanceAutomatedBackupsArn must name another DB instance's automated backups than the one this replaces"
      );
    }
  }
}
