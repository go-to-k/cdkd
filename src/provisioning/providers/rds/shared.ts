import { slowCcOperationTimeoutMs } from '../../slow-cc-operation-timeouts.js';

/**
 * How long a cluster or instance delete waits for the resource to be gone:
 * the Cloud Control route's own DELETE floor for these types, which a Cloud
 * Control-routed delete now reaches through this provider (issue #3993).
 */
export const RDS_DELETE_WAIT_MS = Math.max(
  1_800_000,
  slowCcOperationTimeoutMs('AWS::RDS::DBCluster', 'DELETE'),
  slowCcOperationTimeoutMs('AWS::RDS::DBInstance', 'DELETE')
);

/**
 * The recorded `DeleteAutomatedBackups` as a `DeleteDBCluster` /
 * `DeleteDBInstance` input member (issue #3993), as CloudFormation's delete
 * handler sends the template value. A Cloud Control-routed cluster or
 * instance is deleted through this provider, so a template keeping automated
 * backups with `false` keeps them. Only a boolean or its CFn string spelling
 * is sent; anything else leaves AWS's default (delete them).
 */
export function deleteAutomatedBackupsInput(properties: Record<string, unknown> | undefined): {
  DeleteAutomatedBackups?: boolean;
} {
  const value = properties?.['DeleteAutomatedBackups'];
  if (value === true || value === 'true') return { DeleteAutomatedBackups: true };
  if (value === false || value === 'false') return { DeleteAutomatedBackups: false };
  return {};
}

/**
 * The recorded `GlobalClusterIdentifier` of a cluster, when it names one
 * (issue #4029). Only a non-blank string does; anything else means the record
 * does not show the cluster in a global cluster.
 */
export function recordedGlobalClusterIdentifier(
  properties: Record<string, unknown> | undefined
): string | undefined {
  const value = properties?.['GlobalClusterIdentifier'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * go-to-k/cdkd#5639: whether a `GlobalClusterIdentifier` value is one
 * {@link recordedGlobalClusterIdentifier} can read (absent, `null` or a
 * string). Anything else is refused on a template path and left out on a
 * state-borne one.
 */
export function readableGlobalClusterId(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

export const usableGlobalClusterId = (value: unknown): boolean => typeof value === 'string';

/**
 * go-to-k/cdkd#5639: the `ReplicationSourceIdentifier` CreateDBCluster sends
 * (the source DB instance or cluster ARN of a read replica cluster), as
 * {@link recordedGlobalClusterIdentifier} reads its key: a blank one names
 * none. {@link readableGlobalClusterId} tells a readable value from one
 * refused on a template path and left out on a state-borne one.
 */
export function replicationSourceOf(
  properties: Record<string, unknown> | undefined
): string | undefined {
  const value = properties?.['ReplicationSourceIdentifier'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** What an update does about `GlobalClusterIdentifier` (`planGlobalClusterUpdate`). */
export type GlobalClusterUpdate =
  | { kind: 'none' }
  | { kind: 'keep' }
  | { kind: 'drop' }
  | { kind: 'detach'; globalClusterId: string };

export const GLOBAL_CLUSTER_CHANGE_REFUSED = `GlobalClusterIdentifier cannot be added or changed on an existing DB cluster unless the cluster is already a member of that global cluster (CloudFormation's update handler fails it as "Resource is immutable"). To join a different global cluster, replace the cluster, for example with a new DBClusterIdentifier`;

/**
 * go-to-k/cdkd#5639: the faults a Data API call is refused with while the
 * cluster is busy (`InvalidResourceStateFault` is the one the
 * EnableHttpEndpoint / DisableHttpEndpoint models declare), retried by
 * `sendHttpEndpointChange` up to `HTTP_ENDPOINT_MAX_ATTEMPTS` sends.
 */
export const HTTP_ENDPOINT_BUSY_FAULTS: ReadonlySet<string> = new Set([
  'InvalidResourceStateFault',
  'InvalidDBClusterStateFault',
]);

export const HTTP_ENDPOINT_MAX_ATTEMPTS = 8;

/**
 * Faults a detach waits through rather than failing on: the cluster or the
 * global cluster is busy (`backing-up`, `modifying`), or the call was
 * throttled past the SDK's own retries (issue #4029).
 */
export const TRANSIENT_DETACH_FAULTS: ReadonlySet<string> = new Set([
  'InvalidDBClusterStateFault',
  'InvalidGlobalClusterStateFault',
  'ThrottlingException',
  'Throttling',
  'RequestLimitExceeded',
]);

/**
 * A DB cluster or DB instance identifier: a letter, then letters, digits and
 * single hyphens, not ending in one, at most 63 characters. Either case, as a
 * template may spell it (RDS lower-cases it).
 */
export function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

export function awsErrorName(error: unknown): string {
  return (error as { name?: string } | undefined)?.name ?? '';
}

/**
 * A failure DETACHING a cluster from its global cluster (issue #4029). Its own
 * class so `deleteDBClusterOnce`'s catch rethrows it before the not-found
 * check: an AWS message about the GLOBAL cluster or the membership can read
 * "not found", and that arm would report the live cluster deleted.
 */
export class GlobalClusterDetachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalClusterDetachError';
  }
}

/**
 * Whether the VpcSecurityGroupIds a cluster update SENDS differs from the
 * previous template's list (order-insensitive). `sent === undefined` sends
 * nothing, so nothing changes.
 */
export function securityGroupListChanged(
  sent: readonly string[] | undefined,
  previous: unknown
): boolean {
  if (sent === undefined) return false;
  const before = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string')
    : [];
  return [...sent].sort().join(' ') !== [...before].sort().join(' ');
}
