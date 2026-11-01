import { isDeepStrictEqual } from 'node:util';
import {
  DocDBClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClustersCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
  type DBCluster,
  type DBInstance,
} from '@aws-sdk/client-docdb';
import { getLogger } from '../../utils/logger.js';
import { markNotGone } from '../not-gone.js';
import { enclosingDeadlineRemainingMs } from '../../deployment/resource-deadline.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { coerceCfnBoolean } from '../config-shape.js';
import { isUsableAttemptedName } from '../../state/unsettled-properties.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes, stringifyIfAssigned } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { refuseMalformedDesiredTags } from '../tag-list.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../deployment/secret-redaction.js';
import {
  applyDocDBTagDiff,
  attachDocDBTags,
  docdbLogExportChange,
  docdbServerlessScaling,
  docdbStringList,
  holdsDocDBPendingValue,
  isDocDBNotFoundError,
  wrapDocDBFailure,
} from './docdb-shared.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
  deleteAfterProtectionFlipWithFinalSnapshot,
  isProceedDbStatus,
  isTerminalDbWaitStatus,
} from './deletion-protection-compensation.js';
import { modifyDbInstanceWhenAvailable } from './db-instance-modify-retry.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import { removedTemplateKeys } from '../update-removal.js';

/**
 * go-to-k/cdkd#5153: the `MasterUserPassword` a `ModifyDBCluster` carries, or
 * `undefined` to leave the live password alone. DocumentDB treats ANY supplied
 * password as a master-credential reset (the cluster enters
 * `resetting-master-credentials`), so it is sent only when the template
 * changed it, as CloudFormation does. A removed password sends nothing.
 *
 * The deploy's in-place update decides from `changedProperties`, which
 * compares the templates as written: the record holds a secret as its
 * `{{resolve:...}}` token or `***`, never the plaintext the desired bag holds.
 * A changed reference and a `NoEcho` value count as changed there; a secret
 * rotated under a reference the template spells literally does not, as in
 * CloudFormation (one built by `Fn::Join` counts a newer read version). This
 * type is deliberately NOT in
 * `CHANGED_PROPERTIES_CONSUMER_TYPES`: DescribeDBClusters never returns the
 * password, so the readback that opt-in buys could not confirm it.
 *
 * Without that set the two bags are compared. A rollback revert hands both
 * re-resolved, so an equal password is left out. Under `drift --revert` both
 * sides are AWS readbacks (the desired one with the drifted keys overlaid),
 * which never hold the password, so nothing is sent. A
 * recorded `{{resolve:` token or whole `***` mask is never read as equal.
 * Compared in memory only; the value is never logged.
 */
function masterUserPasswordToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): string | undefined {
  const desired = properties['MasterUserPassword'];
  if (desired === undefined || desired === null) return undefined;
  const changedProperties = context?.changedProperties;
  if (changedProperties !== undefined) {
    return changedProperties.has('MasterUserPassword') ? (desired as string) : undefined;
  }
  const recorded = previousProperties['MasterUserPassword'];
  const unchanged =
    typeof desired === 'string' &&
    typeof recorded === 'string' &&
    recorded === desired &&
    dynamicReferenceTokens(recorded).length === 0 &&
    recorded !== SECRET_MASK;
  return unchanged ? undefined : (desired as string);
}

/**
 * Issue #1160: the port CloudFormation resets a removed DBCluster `Port` to.
 * A real CloudFormation A/B (#1160) measured a removed `Port: 27018` reading
 * back 27017 once the update completed.
 */
const DOCDB_DEFAULT_PORT = 27017;

/** What a cluster declaring none holds; DescribeDBClusters leaves it out for this value. */
const DOCDB_DEFAULT_STORAGE_TYPE = 'standard';

/**
 * go-to-k/cdkd#2762: whether a `ModifyDBCluster` carries
 * `RotateMasterUserPassword: true`. It is a request, not a setting: a template
 * keeping `true` must not rotate the secret on every update, so it goes out only
 * when the previous side does not already hold `true`. A rollback or
 * `drift --revert` restores a bag and never asks for a rotation. CreateDBCluster
 * has no such member.
 */
function rotateMasterUserPassword(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean {
  if (context?.replayingState === true || context?.desiredFromAwsReadback === true) return false;
  return (
    coerceCfnBoolean(properties['RotateMasterUserPassword']) === true &&
    coerceCfnBoolean(previousProperties['RotateMasterUserPassword']) !== true
  );
}

/** Whether two spellings name one KMS key: the same text, or an ARN and its bare id. */
function sameKmsKey(a: string, b: string | undefined): boolean {
  return b !== undefined && a.split('/').pop() === b.split('/').pop();
}

/**
 * Whether a declared scalar differs from what the cluster or instance holds,
 * read off the record, else the live value. `null`, or an equal one, sends
 * nothing. Compared as text: a CFn boolean may arrive as a string.
 */
function declaredChange(
  desired: string | boolean | undefined,
  recorded: unknown,
  live: unknown
): boolean {
  return desired != null && String(desired) !== String(recorded ?? live);
}

/**
 * Issues #5004 / #1160 / #5543 / #2762: the `AWS::DocDB::DBCluster` properties a
 * removal leaves at their live value, because a real CloudFormation A/B showed
 * CloudFormation leaves them: `DeletionProtection` / `BackupRetentionPeriod`
 * (#5004), `VpcSecurityGroupIds` (#1160), then four more (us-east-1,
 * 2026-10-30, #5543). That A/B created a cluster with `EngineVersion: 5.0.0`
 * (the default is 8.0.2), `PreferredBackupWindow: 07:00-08:00`,
 * `PreferredMaintenanceWindow: sun:10:00-sun:10:30` and a custom
 * `DBClusterParameterGroupName`, then removed all four: every one read back
 * unchanged for eight minutes after UPDATE_COMPLETE, both alone and beside a
 * `BackupRetentionPeriod` change that did land. In particular CloudFormation
 * does NOT move the cluster back to `default.docdb5.0`. The last five were
 * measured by a real CloudFormation A/B on engine 5.0.0 (us-east-1, 2026-11-01,
 * #2762), each dropped alone and read at once and about four minutes later;
 * after a stack rollback `CopyTagsToSnapshot` and `EnableCloudwatchLogsExports`
 * still held their values too. Neptune RESETS a removed log export: do not
 * copy its handling here. `MasterUserSecretKmsKeyId` was measured with
 * `ManageMasterUserPassword` staying `true`.
 */
export const DOCDB_CLUSTER_KEPT_ON_REMOVAL = [
  'DeletionProtection',
  'BackupRetentionPeriod',
  'VpcSecurityGroupIds',
  'EngineVersion',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
  'CopyTagsToSnapshot',
  'EnableCloudwatchLogsExports',
  'StorageType',
  'ServerlessV2ScalingConfiguration',
  'MasterUserSecretKmsKeyId',
] as const;

/**
 * Removals `update()` leaves at the live value (ModifyDBCluster keeps a setting
 * it is not sent) but no A/B has measured (#2762): `NetworkType` was only ever
 * IPV4, and removing `ManageMasterUserPassword` needs a password declared. The
 * warning names them and claims no parity.
 */
const DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL = ['NetworkType', 'ManageMasterUserPassword'] as const;

/**
 * Issues #5543 / #2762: the `AWS::DocDB::DBInstance` counterpart. The last two
 * are the #2762 A/B (`EnablePerformanceInsights` on a db.r6g.large).
 */
const DOCDB_INSTANCE_KEPT_ON_REMOVAL = [
  'PreferredMaintenanceWindow',
  'CACertificateIdentifier',
  'EnablePerformanceInsights',
] as const;

/**
 * go-to-k/cdkd#5380: the keys an accepted Modify may leave half-applied when a
 * later step of the update fails. Only the #2762 ones: `update()` compares each
 * but `CopyTagsToSnapshot`, which goes out on every update, with the previous
 * side before sending it. The credential keys stay out: a key sent while the
 * password stays managed is refused, so a live value on the previous side would
 * turn a resend into a failure.
 */
const CLUSTER_MODIFY_UNSETTLED_KEYS = [
  'CopyTagsToSnapshot',
  'EnableCloudwatchLogsExports',
  'NetworkType',
  'ServerlessV2ScalingConfiguration',
  'StorageType',
] as const;
const INSTANCE_MODIFY_UNSETTLED_KEYS = [
  'CACertificateIdentifier',
  'EnablePerformanceInsights',
] as const;

/** How long an accepted change is waited on before a warning. */
const SETTLE_MAX_WAIT_MS = 300_000;

/**
 * The same for a `StorageType` change, the provisioned-cluster change that takes
 * longest: a real run (go-to-k/cdkd#2762) was still `standard` after five minutes
 * and the member instance was refused as not `available` for over a minute more.
 * The bound the cluster's other update waits use.
 */
const STORAGE_SETTLE_MAX_WAIT_MS = 1_800_000;

/** Budget kept back from the enclosing resource deadline. */
const DEADLINE_MARGIN_MS = 30_000;

/**
 * The ONE warning line naming each of `keys` removed, which the resource keeps
 * at its live value as CloudFormation does, or `undefined` when none was.
 * The logical id is template-borne, so the line goes through `safeMsg`. A
 * deploy reads `removedProperties` (template to template); without it (a
 * direct call) the two bags are compared by `removedTemplateKeys`. A `drift --revert`
 * sets it empty, since its previous side is a readback. A rollback revert
 * restores an earlier state record, so there the property is one the failed
 * deploy ADDED, and the line says that instead.
 */
function keptOnRemovalWarning(
  keys: readonly string[],
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  logicalId: string,
  resourceType: string,
  measured = true
): string | undefined {
  const removedProperties = context?.removedProperties;
  const removedSet =
    removedProperties ?? new Set(removedTemplateKeys(previousProperties, properties));
  const removed = keys.filter((key) => removedSet.has(key));
  if (removed.length === 0) return undefined;
  const one = removed.length === 1;
  const names = `${one ? 'property' : 'properties'} ${removed.join(', ')}`;
  const modify = resourceType === 'AWS::DocDB::DBInstance' ? 'ModifyDBInstance' : 'ModifyDBCluster';
  return context?.replayingState
    ? safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'is' : 'are'} absent from the state being restored; ${modify} keeps a setting it is not sent, so the rollback leaves any value the failed deploy applied in place.`
    : safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS ${one ? 'value' : 'values'} in place${measured ? ', as CloudFormation does' : ''}. Declare ${one ? 'it' : 'them'} to change ${one ? 'it' : 'them'}.`;
}

/** Issue #1160: the member statuses a cluster change moves an instance through. */
const SECURITY_GROUP_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying']);
const PORT_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying', 'rebooting']);

/** A template number (CFn numbers may arrive as strings), or `undefined` when absent. */
function numberOrUndefined(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

/** The ModifyDBCluster `Port`: the declared one, or the default on removal. */
function clusterPortToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): number | undefined {
  if (properties['Port'] != null) return Number(properties['Port']);
  if (previousProperties['Port'] == null) return undefined;
  // The removed value already was the default: nothing to change.
  return Number(previousProperties['Port']) === DOCDB_DEFAULT_PORT ? undefined : DOCDB_DEFAULT_PORT;
}

/**
 * The attribute map a DocumentDB DB cluster records (issue #3650), under
 * CloudFormation's `Fn::GetAtt` names (`Endpoint`, `Port`, `ReadEndpoint`,
 * `ClusterResourceId`). The RDS-style dotted keys (`Endpoint.Address`, ...)
 * are kept for records and readers that already use them; no
 * `Fn::GetAtt` names them for this service, so on their own they left
 * `Fn::GetAtt [Cluster, Endpoint]` resolving to the cluster identifier.
 */
function clusterAttributes(
  cluster:
    | {
        Endpoint?: string | undefined;
        Port?: number | undefined;
        ReaderEndpoint?: string | undefined;
        DBClusterArn?: string | undefined;
        DbClusterResourceId?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: cluster?.Endpoint,
    Port: stringifyIfAssigned(cluster?.Port),
    ReadEndpoint: cluster?.ReaderEndpoint,
    'Endpoint.Address': cluster?.Endpoint,
    'Endpoint.Port': stringifyIfAssigned(cluster?.Port),
    'ReadEndpoint.Address': cluster?.ReaderEndpoint,
    Arn: cluster?.DBClusterArn,
    ClusterResourceId: cluster?.DbClusterResourceId,
  });
}

/**
 * The attribute map a DocumentDB DB instance records (issue #3650): `Endpoint` /
 * `Port` are CloudFormation's `Fn::GetAtt` names, the dotted keys are kept.
 */
function instanceAttributes(
  instance:
    | {
        Endpoint?: { Address?: string | undefined; Port?: number | undefined } | undefined;
        DBInstanceArn?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: instance?.Endpoint?.Address,
    Port: stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    Arn: instance?.DBInstanceArn,
  });
}

/**
 * A DB cluster or DB instance identifier: a letter, then letters, digits and
 * single hyphens, not ending in one, at most 63 characters. Either case, as a
 * template may spell it (the service lower-cases it).
 */
function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

/**
 * AWS DocumentDB Provider
 *
 * Implements resource provisioning for DocumentDB resources:
 * - AWS::DocDB::DBCluster
 * - AWS::DocDB::DBInstance
 *
 * `AWS::DocDB::DBSubnetGroup` has its own provider,
 * `DocDBSubnetGroupProvider`: see {@link DocDBProvider.disableCcApiFallback}.
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off for `AWS::DocDB::DBCluster`.
 *      DocDB inherits the RDS-shaped `DeletionProtection` boolean on the
 *      cluster (NOT on the instance — DocDB DBInstance has no
 *      DeletionProtection field per the AWS SDK), and the bypass logic
 *      lives in per-type SDK providers, not in `cloud-control-provider.ts`.
 *   2. Direct SDK calls avoid CC API polling overhead. DocDB cluster /
 *      instance creation still takes time (1–5 min), so we poll
 *      `DescribeDBClusters` / `DescribeDBInstances` until status flips to
 *      `available`.
 *
 * DocDB's API shapes mirror the RDS API exactly (the AWS team copied them
 * across); see `rds-provider.ts` for the structural template.
 */
export class DocDBProvider implements ResourceProvider {
  private docdbClient?: DocDBClient;
  private createClient?: DocDBClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('DocDBProvider');
  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * `AWS::DocDB::DBCluster` and `AWS::DocDB::DBInstance` are
   * `ProvisioningType: NON_PROVISIONABLE` — Cloud Control has no handlers for
   * them — so the #614 silent-drop auto-route must not send a template using
   * an unhandled property (`GlobalClusterIdentifier`, `RestoreType`,
   * `SnapshotIdentifier`, ...) to CC, where it fails mid-deploy with an
   * opaque UnsupportedActionException. With this opt-out the registry refuses
   * such a template pre-flight (issue #3866).
   *
   * The flag is per PROVIDER, which is why `AWS::DocDB::DBSubnetGroup` — a
   * type Cloud Control CAN manage — lives in `DocDBSubnetGroupProvider`, keeping
   * its Cloud Control route. Do not register it on this class again.
   */
  readonly disableCcApiFallback = true;

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every handled
   * property of both types, each removal handled by `update()`, so the shared
   * caller warns about none of them.
   *
   * No `removalDefaults` (issue #5004): ModifyDBCluster / ModifyDBInstance
   * merge (an absent field means "no change"), and a real CloudFormation A/B
   * showed CloudFormation KEEPS the live value of every removal listed under
   * `*_KEPT_ON_REMOVAL`, which `update()` names in its own warning. The one
   * DocDB reset CloudFormation was measured to make, a removed cluster `Port`,
   * is computed locally (`clusterPortToSend`). Four entries are listed without
   * an A/B, because no reset value exists: a removed `MasterUserPassword` (a
   * secret with no default), the per-call `RotateMasterUserPassword` and
   * `CertificateRotationRestart`, and the instance `AutoMinorVersionUpgrade`
   * (inert on DocDB, see `updateDBInstance`). The UNMEASURED cluster list is
   * named in a warning that claims no parity.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DocDB::DBCluster',
      new Set([
        // Create-only: a removal replaces.
        'AvailabilityZones',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'KmsKeyId',
        'MasterUsername',
        'StorageEncrypted',
        // Reset to 27017 (`clusterPortToSend`), as CloudFormation resets it.
        'Port',
        // Diffed (AddTagsToResource / RemoveTagsFromResource).
        'Tags',
        // Not measured: a secret with no default to reset to, so a removal
        // sends nothing and the cluster keeps its password.
        'MasterUserPassword',
        // A request, not a setting: nothing to reset.
        'RotateMasterUserPassword',
        // Left in place, as CloudFormation leaves them (CFn A/B), and named in
        // update()'s own warning.
        ...DOCDB_CLUSTER_KEPT_ON_REMOVAL,
        // Left in place and named in the warning claiming no parity.
        ...DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL,
      ]),
    ],
    [
      'AWS::DocDB::DBInstance',
      new Set([
        // Create-only (a removal replaces) or required (DBInstanceClass).
        'DBInstanceIdentifier',
        'DBClusterIdentifier',
        'AvailabilityZone',
        'DBInstanceClass',
        // Diffed (AddTagsToResource / RemoveTagsFromResource).
        'Tags',
        // Not measured: inert on DocDB (see updateDBInstance), no value to reset.
        'AutoMinorVersionUpgrade',
        // Rides a CACertificateIdentifier change only: nothing to reset.
        'CertificateRotationRestart',
        // Left in place, as CloudFormation leaves it (CFn A/B 2026-10-30,
        // #5543), and named in update()'s own warning.
        ...DOCDB_INSTANCE_KEPT_ON_REMOVAL,
      ]),
    ],
  ]);

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DocDB::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'DBClusterParameterGroupName',
        'DeletionProtection',
        'Tags',
        'AvailabilityZones',
        'CopyTagsToSnapshot',
        'EnableCloudwatchLogsExports',
        'ManageMasterUserPassword',
        'MasterUserSecretKmsKeyId',
        'NetworkType',
        'RotateMasterUserPassword',
        'ServerlessV2ScalingConfiguration',
        'StorageType',
      ]),
    ],
    [
      'AWS::DocDB::DBInstance',
      // DocDB DBInstance does NOT support DeletionProtection (verified
      // against the @aws-sdk/client-docdb CreateDBInstanceMessage type —
      // the field is absent). Cluster-level DeletionProtection covers the
      // common case anyway; instance deletes are gated by the cluster's
      // protection flag in normal use.
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'DBClusterIdentifier',
        'AvailabilityZone',
        'PreferredMaintenanceWindow',
        'AutoMinorVersionUpgrade',
        'Tags',
        'CACertificateIdentifier',
        'CertificateRotationRestart',
        'EnablePerformanceInsights',
      ]),
    ],
  ]);

  private getClient(): DocDBClient {
    if (!this.docdbClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.docdbClient = new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new DocDBClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.docdbClient;
  }

  /**
   * The client `CreateDBCluster` / `CreateDBInstance` go through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * Neither carries an idempotency token, and each identifier is unique per
   * account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): DocDBClient {
    this.getClient();
    return this.createClient as DocDBClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = context?.maskSecrets;
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.createDBCluster(
          logicalId,
          resourceType,
          properties,
          mask,
          context?.replayingState === true
        );
      case 'AWS::DocDB::DBInstance':
        return this.createDBInstance(
          logicalId,
          resourceType,
          properties,
          mask,
          context?.replayingState === true
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        );
      case 'AWS::DocDB::DBInstance':
        return this.updateDBInstance(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::DocDB::DBInstance':
        return this.deleteDBInstance(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── Failure wrap ─────────────────────────────────────────────────

  /**
   * The failure wrap the create, update and delete catches throw
   * ({@link wrapDocDBFailure}, go-to-k/cdkd#2319). A method, so
   * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
   */
  private wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapDocDBFailure(this.logger, mask, error, build);
  }

  /**
   * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
   * by its CLASS, and the delete classifiers read `NotFound` in a message as
   * "already deleted": a class naming ANOTHER object's not-found (this
   * resource's own not-found returned before the wrap) is marked
   * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
   */
  private wrapDeleteError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const thrown = this.wrapCaughtError(mask, error, build);
    return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DocDB DBCluster ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const origin = { stateBorne: replayingState };
    const { logTypes, scaling } = this.readClusterBlocks(
      properties,
      resourceType,
      logicalId,
      origin,
      true
    );
    const managedPassword = this.readBooleanProperty(
      'ManageMasterUserPassword',
      properties,
      resourceType,
      logicalId,
      origin
    );
    const password = this.passwordBesideManaged(
      managedPassword,
      false,
      properties['MasterUserPassword'] as string | undefined,
      resourceType,
      logicalId,
      origin
    );

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generatedNameFor('AWS::DocDB::DBCluster', logicalId);

    // go-to-k/cdkd#4583: set once CreateDBCluster returned (no self-cleanup).
    let clusterCreated = false;
    // go-to-k/cdkd#4606: the `DbClusterResourceId` CreateDBCluster returned,
    // carried on the failure's mark as the orphan's identity.
    let createdResourceId: string | undefined;
    try {
      const response = await this.getCreateClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          // DocDB engine value is fixed: only `docdb` is accepted.
          Engine: 'docdb',
          EngineVersion: properties['EngineVersion'] as string | undefined,
          MasterUsername: properties['MasterUsername'] as string | undefined,
          MasterUserPassword: password,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
          KmsKeyId: properties['KmsKeyId'] as string | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          AvailabilityZones: properties['AvailabilityZones'] as string[] | undefined,
          CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
          ManageMasterUserPassword: managedPassword,
          MasterUserSecretKmsKeyId: properties['MasterUserSecretKmsKeyId'] as string | undefined,
          NetworkType: properties['NetworkType'] as string | undefined,
          StorageType: properties['StorageType'] as string | undefined,
          ...(logTypes !== undefined &&
            logTypes.length > 0 && { EnableCloudwatchLogsExports: logTypes }),
          ...(scaling != null && { ServerlessV2ScalingConfiguration: scaling }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      clusterCreated = true;
      createdResourceId = response.DBCluster?.DbClusterResourceId;
      // go-to-k/cdkd#5511: report before the availability wait.
      reportCreatedResource(logicalId, resourceType, dbClusterIdentifier, createdResourceId);

      const cluster = response.DBCluster;
      if (!cluster) {
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(
        `Successfully created DocDB DBCluster ${logicalId}: ${dbClusterIdentifier}`
      );

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(logicalId, dbClusterIdentifier);
      }

      // Describe to get final attributes
      const described = await this.describeDBCluster(dbClusterIdentifier);

      return {
        physicalId: dbClusterIdentifier,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : this.wrapCaughtError(
              mask,
              error,
              (text) =>
                new ProvisioningError(
                  `Failed to create DocDB DBCluster ${logicalId}: ${text}`,
                  resourceType,
                  logicalId,
                  dbClusterIdentifier,
                  error instanceof Error ? error : undefined
                )
            );
      // go-to-k/cdkd#4583: the cluster exists and no state record will hold
      // it; never before CreateDBCluster returned (another owner's name).
      if (clusterCreated) {
        markCreatedBeforeFailure(
          thrown,
          logicalId,
          resourceType,
          dbClusterIdentifier,
          createdResourceId
        );
      }
      throw thrown;
    }
  }

  private async updateDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DocDB DBCluster ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    const origin = {
      stateBorne: context?.replayingState === true || context?.desiredFromAwsReadback === true,
      physicalId,
    };
    const { logTypes, scaling } = this.readClusterBlocks(
      properties,
      resourceType,
      logicalId,
      origin,
      false
    );
    // An absent list is a removal, which CloudFormation keeps (#2762 A/B); only
    // a declared one is a delta. A malformed record only misses disables.
    const logExportConfig =
      logTypes === undefined
        ? undefined
        : docdbLogExportChange(
            logTypes,
            docdbStringList(previousProperties['EnableCloudwatchLogsExports']) ?? []
          );

    try {
      const credentials = await this.planMasterCredentials(
        physicalId,
        properties,
        previousProperties,
        resourceType,
        logicalId,
        context,
        origin
      );
      // Class 2 — `VpcSecurityGroupIds: []` would CLEAR all SGs on the
      // cluster. readCurrentState always-emits `[]` for clusters that
      // legitimately have no VPC SGs; the round-trip must NOT translate
      // that placeholder into a destructive SDK call.
      const vpcSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
      const sendVpcSgIds = vpcSgIds !== undefined && vpcSgIds.length > 0;

      // #1160 reset-on-removal — ModifyDBCluster has merge semantics (an
      // absent input field means "no change"), so a property REMOVED from
      // the template is sent as an explicit reset only where CloudFormation resets
      // it; #5004 measured DeletionProtection / BackupRetentionPeriod
      // (and IamAuthEnabled / AutoMinorVersionUpgrade on Neptune) as KEPT,
      // so those are not reset. Deliberately NOT reset here:
      //   * EngineVersion, DBClusterParameterGroupName,
      //     PreferredBackupWindow, PreferredMaintenanceWindow — a real
      //     CloudFormation A/B (#5543, `DOCDB_CLUSTER_KEPT_ON_REMOVAL`) showed
      //     CloudFormation KEEPS all four on removal (the cluster stays on its
      //     version, its custom parameter group and its windows), so an
      //     absent value is passed through as absent.
      //   * MasterUserPassword — a secret; removal cannot synthesize a
      //     reset value.
      //   * VpcSecurityGroupIds — a real CloudFormation A/B (issue #1160)
      //     showed CloudFormation KEEPS a DocDB cluster's groups when the
      //     property is removed, so a removal sends nothing. RDS and Neptune
      //     differ: there CloudFormation moves the cluster to the VPC's
      //     default security group.
      // A removed Port IS reset, to 27017 (`clusterPortToSend`): a real
      // CloudFormation A/B (#1160) read a removed `Port: 27018` back as 27017.
      const portToSend = clusterPortToSend(properties, previousProperties);
      // A value the record does not hold compares with the live one: NetworkType
      // and StorageType are real changes, AWS limits StorageType changes, and
      // it reports no StorageType for `standard`.
      const unrecorded = (key: string): boolean =>
        properties[key] != null && previousProperties[key] == null;
      const live =
        unrecorded('NetworkType') ||
        unrecorded('StorageType') ||
        logExportConfig?.EnableLogTypes !== undefined
          ? await this.describeDBCluster(physicalId)
          : undefined;
      const networkType = properties['NetworkType'] as string | undefined;
      const networkChange = declaredChange(
        networkType,
        previousProperties['NetworkType'],
        live?.NetworkType
      );
      const storageType = properties['StorageType'] as string | undefined;
      const storageChange = declaredChange(
        storageType,
        previousProperties['StorageType'],
        live?.StorageType ?? DOCDB_DEFAULT_STORAGE_TYPE
      );
      const previousScaling = docdbServerlessScaling(
        previousProperties['ServerlessV2ScalingConfiguration']
      );
      const scalingChange =
        scaling != null &&
        (scaling.MinCapacity !== previousScaling?.MinCapacity ||
          scaling.MaxCapacity !== previousScaling?.MaxCapacity);
      this.markChangedUnsettled(
        CLUSTER_MODIFY_UNSETTLED_KEYS,
        properties,
        previousProperties,
        context
      );
      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          // #5004: CloudFormation KEEPS the live value of a removed
          // DeletionProtection / BackupRetentionPeriod, so an absent value
          // is passed through as absent (no reset).
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          ...(sendVpcSgIds && { VpcSecurityGroupIds: vpcSgIds }),
          // #5153: only a changed password; any supplied one resets credentials.
          MasterUserPassword: credentials.password,
          Port: portToSend,
          CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
          // #2762: a request for this update, never a setting to repeat.
          ...(rotateMasterUserPassword(properties, previousProperties, context) && {
            RotateMasterUserPassword: true,
          }),
          ...(credentials.managed !== undefined && {
            ManageMasterUserPassword: credentials.managed,
          }),
          ...(credentials.secretKmsKey !== undefined && {
            MasterUserSecretKmsKeyId: credentials.secretKmsKey,
          }),
          // Each sent only on a change: re-sending asks AWS for one every update.
          ...(networkChange && { NetworkType: networkType }),
          ...(storageChange && { StorageType: storageType }),
          ...(scalingChange && { ServerlessV2ScalingConfiguration: scaling }),
          ...(logExportConfig !== undefined && {
            CloudwatchLogsExportConfiguration: logExportConfig,
          }),
          ApplyImmediately: true,
        })
      );

      // go-to-k/cdkd#5498: what this call added, so a convergence after a later
      // failure disables it, and nothing an out-of-band change enabled.
      const addedLogTypes = (logExportConfig?.EnableLogTypes ?? []).filter(
        (type) => !live?.EnabledCloudwatchLogsExports?.includes(type)
      );
      if (addedLogTypes.length > 0) {
        context?.markAttempted?.('EnableCloudwatchLogsExports', addedLogTypes);
      }

      this.logger.debug(`Successfully updated DocDB DBCluster ${logicalId}`);

      // A changed Port (declared, or the default on removal) applies
      // asynchronously: the describe below could still read the old one, and a
      // same-deploy `Fn::GetAtt <cluster>.Port` would get it. CloudFormation
      // reports the update once it has settled, so wait for the new port first,
      // then for the member instances it moved to `modifying` / `rebooting`, whose
      // own Modify* in the same deploy would otherwise be refused. An unchanged
      // port adds no call; `--no-wait` skips both.
      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      const portChanged =
        portToSend !== undefined && portToSend !== numberOrUndefined(previousProperties['Port']);
      if (!noWait && portChanged) {
        await this.waitForClusterPortApplied(physicalId, logicalId, portToSend);
      }

      const described = await this.describeDBCluster(physicalId);

      if (!noWait) {
        // The observed baseline is captured after update(): an old value read
        // here is a phantom drift later. The delta, not the whole list: a log
        // type enabled out of band is not ours.
        const { EnableLogTypes: enabled = [], DisableLogTypes: disabled = [] } =
          logExportConfig ?? {};
        const applied = new Map<string, (cluster: DBCluster | undefined) => boolean>();
        if (logExportConfig !== undefined) {
          applied.set('EnableCloudwatchLogsExports', (cluster) => {
            const logs = cluster?.EnabledCloudwatchLogsExports;
            return (
              enabled.every((type) => logs?.includes(type)) &&
              !disabled.some((type) => logs?.includes(type))
            );
          });
        }
        if (networkChange) {
          applied.set('NetworkType', (cluster) => cluster?.NetworkType === networkType);
        }
        if (storageChange) {
          applied.set(
            'StorageType',
            (cluster) => (cluster?.StorageType ?? DOCDB_DEFAULT_STORAGE_TYPE) === storageType
          );
        }
        if (scalingChange) {
          applied.set('ServerlessV2ScalingConfiguration', (cluster) => {
            const live = cluster?.ServerlessV2ScalingConfiguration;
            return (
              live?.MinCapacity === scaling?.MinCapacity &&
              live?.MaxCapacity === scaling?.MaxCapacity
            );
          });
        }
        await this.waitForApplied(
          logicalId,
          applied,
          () => this.describeDBCluster(physicalId),
          storageChange ? STORAGE_SETTLE_MAX_WAIT_MS : SETTLE_MAX_WAIT_MS
        );
      }

      if (!noWait && portChanged) {
        for (const member of described?.DBClusterMembers ?? []) {
          if (member.DBInstanceIdentifier) {
            await this.waitForMemberAfterClusterChange(
              member.DBInstanceIdentifier,
              logicalId,
              PORT_CHANGE_MEMBER_STATUSES,
              'port'
            );
          }
        }
      }

      // A changed VpcSecurityGroupIds also moves every member instance to
      // `modifying` within about a second, and a member's own Modify* in the
      // same deploy is then refused ("Database instance is not in available
      // state"). CloudFormation reports the update only once it has settled, so
      // wait here, but ONLY when the sent list differs from the previous one:
      // an unchanged list (re-sent on every update) adds no time. `--no-wait`
      // skips it, exactly as create() skips waitForClusterAvailable.
      if (
        process.env['CDKD_NO_WAIT'] !== 'true' &&
        securityGroupListChanged(
          sendVpcSgIds ? vpcSgIds : undefined,
          previousProperties['VpcSecurityGroupIds']
        )
      ) {
        await this.waitForSecurityGroupsApplied(
          physicalId,
          logicalId,
          (sendVpcSgIds ? vpcSgIds : undefined) ?? []
        );
        for (const member of described?.DBClusterMembers ?? []) {
          if (member.DBInstanceIdentifier) {
            await this.waitForMemberAfterClusterChange(
              member.DBInstanceIdentifier,
              logicalId,
              SECURITY_GROUP_CHANGE_MEMBER_STATUSES,
              'VPC security groups'
            );
          }
        }
      }

      if (described?.DBClusterArn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          described.DBClusterArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      // #5543: after every call succeeded, so a failed or retried update
      // never prints it.
      const keptWarning = keptOnRemovalWarning(
        DOCDB_CLUSTER_KEPT_ON_REMOVAL,
        properties,
        previousProperties,
        context,
        logicalId,
        resourceType
      );
      if (keptWarning !== undefined) this.logger.warn(keptWarning);
      const unmeasuredWarning = keptOnRemovalWarning(
        DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL,
        properties,
        previousProperties,
        context,
        logicalId,
        resourceType,
        false
      );
      if (unmeasuredWarning !== undefined) this.logger.warn(unmeasuredWarning);
      if (credentials.heldWarning !== undefined) this.logger.warn(credentials.heldWarning);

      return {
        physicalId,
        wasReplaced: false,
        // Under `--no-wait` the describe can still read the OLD port; record the
        // one sent, or a `Fn::GetAtt <cluster>.Port` consumer stays stale.
        attributes: clusterAttributes(
          noWait && portChanged && described !== undefined
            ? { ...described, Port: portToSend }
            : described
        ),
      };
    } catch (error) {
      // A refusal of ours names its own cause.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update DocDB DBCluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * The compensation boundary (issue #2204): a `--remove-protection` flip whose
   * delete then fails terminally is undone here, so a destroy that did not
   * happen does not leave a live cluster with its guard stripped. DocDB
   * instances carry no guard of their own, so the cluster is the only site.
   */
  private async deleteDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    await deleteWithProtectionCompensation({
      registry: this.protectionFlips,
      key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
      run: (flip) => this.deleteDBClusterOnce(logicalId, physicalId, resourceType, context, flip),
      compensation: {
        logicalId,
        physicalId,
        logger: this.logger,
        site: rdsFamilyProtectionSite({
          cliService: 'docdb',
          serviceLabel: 'DocDB',
          kind: 'cluster',
          physicalId,
          region: context?.expectedRegion,
          notFoundFault: 'DBClusterNotFoundFault',
          isNotFound: (error) => isDocDBNotFoundError(error, 'DBClusterNotFoundFault'),
        }),
        reEnable: async () => {
          await this.getClient().send(
            new ModifyDBClusterCommand({
              DBClusterIdentifier: physicalId,
              DeletionProtection: true,
              ApplyImmediately: true,
            })
          );
        },
      },
    });
  }

  private async deleteDBClusterOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    this.logger.debug(`Deleting DocDB DBCluster ${logicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — DocDB accepts the call when protection
      // is already disabled. Non-fatal: log at debug if the flip-off
      // errors (e.g. NotFound) so the actual delete still proceeds.
      // The pre-flip readback is what lets a terminal failure restore ONLY a
      // guard this run turned off (issue #2204).
      if (context?.removeProtection === true) {
        try {
          await observeThenDisableProtection({
            flip,
            logger: this.logger,
            physicalId,
            mask: context?.maskSecrets,
            guardName: 'DeletionProtection',
            observe: async () =>
              (await this.describeDBCluster(physicalId))?.DeletionProtection === true,
            disable: async () => {
              await this.getClient().send(
                new ModifyDBClusterCommand({
                  DBClusterIdentifier: physicalId,
                  DeletionProtection: false,
                  ApplyImmediately: true,
                })
              );
            },
          });
          this.logger.debug(
            `Disabled DeletionProtection on DocDB DBCluster ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!isDocDBNotFoundError(disableError, 'DBClusterNotFoundFault')) {
            this.logger.debug(
              maskerOrIdentity(context?.maskSecrets)(
                `Could not disable deletion protection for DocDB DBCluster ${logicalId}: ${describeAwsFailure(disableError).detail}`
              )
            );
          }
        }
      }

      // `DeletionPolicy: Snapshot` (issue #1352): flip to the atomic
      // final-snapshot delete when the destroy call site passed an id.
      const finalSnapshotId = context?.finalSnapshotIdentifier;
      // Issue #5155: a final snapshot needs `available`, which the flip above
      // briefly takes away. Only a flip of this run AND a snapshot wait, and
      // never once AWS accepted the delete (a re-entry after a failed wait).
      const sendDelete = () =>
        this.getClient().send(
          new DeleteDBClusterCommand({
            DBClusterIdentifier: physicalId,
            ...(finalSnapshotId
              ? { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshotId }
              : { SkipFinalSnapshot: true }),
          })
        );
      if (finalSnapshotId && flip.flippedOffByThisRun && !flip.deleteAccepted) {
        // Issue #5184: waits, then retries a delete AWS refuses as not `available`.
        await this.deleteAfterProtectionFlip(logicalId, physicalId, sendDelete);
      } else {
        await sendDelete();
      }
      // AWS took the delete: a later throw is the WAIT failing, and the guard
      // must not be put back on a cluster that is being deleted.
      flip.deleteAccepted = true;
      // Not the identifier: it embeds the physical id, which may be secret-derived
      // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/cli-destroy.md).
      if (finalSnapshotId) {
        this.logger.info(
          `Deleting DocDB DBCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
        );
      }

      this.logger.debug(`Successfully initiated deletion of DocDB DBCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(logicalId, physicalId);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  DocDB DB cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`DocDB DBCluster ${logicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete DocDB DBCluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // ─── DBInstance ───────────────────────────────────────────────────

  private async createDBInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DocDB DBInstance ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const insights = this.readBooleanProperty(
      'EnablePerformanceInsights',
      properties,
      resourceType,
      logicalId,
      { stateBorne: replayingState }
    );

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generatedNameFor('AWS::DocDB::DBInstance', logicalId);

    // go-to-k/cdkd#4583: set once CreateDBInstance returned (no self-cleanup).
    let instanceCreated = false;
    // go-to-k/cdkd#4606: the `DbiResourceId` CreateDBInstance returned,
    // carried on the failure's mark as the orphan's identity.
    let createdResourceId: string | undefined;
    try {
      const response = await this.getCreateClient().send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBInstanceClass: properties['DBInstanceClass'] as string,
          // DocDB engine value is fixed: only `docdb` is accepted.
          Engine: 'docdb',
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string,
          AvailabilityZone: properties['AvailabilityZone'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          CACertificateIdentifier: properties['CACertificateIdentifier'] as string | undefined,
          EnablePerformanceInsights: insights,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      instanceCreated = true;
      createdResourceId = response.DBInstance?.DbiResourceId;
      // go-to-k/cdkd#5511: report before the availability wait.
      reportCreatedResource(logicalId, resourceType, dbInstanceIdentifier, createdResourceId);

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(
        `Successfully created DocDB DBInstance ${logicalId}: ${dbInstanceIdentifier}`
      );

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(logicalId, dbInstanceIdentifier);
      }

      const described = await this.describeDBInstance(dbInstanceIdentifier);

      return {
        physicalId: dbInstanceIdentifier,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : this.wrapCaughtError(
              mask,
              error,
              (text) =>
                new ProvisioningError(
                  `Failed to create DocDB DBInstance ${logicalId}: ${text}`,
                  resourceType,
                  logicalId,
                  dbInstanceIdentifier,
                  error instanceof Error ? error : undefined
                )
            );
      // go-to-k/cdkd#4583: the instance exists and no state record will hold
      // it; never before CreateDBInstance returned (another owner's name).
      if (instanceCreated) {
        markCreatedBeforeFailure(
          thrown,
          logicalId,
          resourceType,
          dbInstanceIdentifier,
          createdResourceId
        );
      }
      throw thrown;
    }
  }

  private async updateDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DocDB DBInstance ${logicalId}: ${physicalId}`);
    const mask = context?.maskSecrets;
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    const insights = this.readBooleanProperty(
      'EnablePerformanceInsights',
      properties,
      resourceType,
      logicalId,
      {
        stateBorne: context?.replayingState === true || context?.desiredFromAwsReadback === true,
        physicalId,
      }
    );

    try {
      // #1160 reset-on-removal — ModifyDBInstance has merge semantics, but
      // every optional DocDB instance field is deliberately NOT reset:
      //   * AutoMinorVersionUpgrade — inert on DocDB (ModifyDBInstanceMessage
      //     doc: "This parameter does not apply to Amazon DocumentDB.
      //     Amazon DocumentDB does not perform minor version upgrades
      //     regardless of the value set"); synthesizing a reset would close
      //     no behavioral divergence.
      //   * PreferredMaintenanceWindow — a real CloudFormation A/B (#5543)
      //     showed CloudFormation KEEPS a removed window (alone and beside
      //     another instance change), so a removal sends nothing.
      //   * CACertificateIdentifier, EnablePerformanceInsights — KEPT too
      //     (#2762 A/B). Each goes out on a change only: re-sending either asks
      //     AWS for a restart or a feature change on every update.
      //     CertificateRotationRestart rides a certificate change, the one
      //     call it applies to; CreateDBInstance has no such member.
      const certificate = properties['CACertificateIdentifier'] as string | undefined;
      const live =
        (certificate != null && previousProperties['CACertificateIdentifier'] == null) ||
        (insights !== undefined && previousProperties['EnablePerformanceInsights'] == null)
          ? await this.describeDBInstance(physicalId)
          : undefined;
      const certificateChange = declaredChange(
        certificate,
        previousProperties['CACertificateIdentifier'],
        live?.CACertificateIdentifier
      );
      const insightsChange = declaredChange(
        insights,
        previousProperties['EnablePerformanceInsights'],
        live?.PerformanceInsightsEnabled ?? false
      );
      this.markChangedUnsettled(
        INSTANCE_MODIFY_UNSETTLED_KEYS,
        properties,
        previousProperties,
        context
      );
      // #5194: a cluster change in the same deploy can leave this member not
      // `available` for a moment; only that refusal is waited out and resent.
      await modifyDbInstanceWhenAvailable({
        send: () =>
          this.getClient().send(
            new ModifyDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
              PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
                | string
                | undefined,
              AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
              ...(certificateChange && { CACertificateIdentifier: certificate }),
              ...(certificateChange &&
                properties['CertificateRotationRestart'] != null && {
                  CertificateRotationRestart: properties['CertificateRotationRestart'] as boolean,
                }),
              ...(insightsChange && { EnablePerformanceInsights: insights }),
              ApplyImmediately: true,
            })
          ),
        readStatus: async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
        sleep: (ms) => this.sleep(ms),
        logger: this.logger,
        label: 'DocDB DBInstance',
        logicalId,
        remainingMs: enclosingDeadlineRemainingMs(),
      });

      this.logger.debug(`Successfully updated DocDB DBInstance ${logicalId}`);

      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        const applied = new Map<string, (instance: DBInstance | undefined) => boolean>();
        if (certificateChange) {
          applied.set(
            'CACertificateIdentifier',
            (instance) => instance?.CACertificateIdentifier === certificate
          );
        }
        if (insightsChange) {
          applied.set(
            'EnablePerformanceInsights',
            (instance) => instance?.PerformanceInsightsEnabled === insights
          );
        }
        await this.waitForApplied(logicalId, applied, () => this.describeDBInstance(physicalId));
      }

      const described = await this.describeDBInstance(physicalId);

      if (described?.DBInstanceArn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          described.DBInstanceArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      // #5543: after every call succeeded, so a failed or retried update
      // never prints it.
      const keptWarning = keptOnRemovalWarning(
        DOCDB_INSTANCE_KEPT_ON_REMOVAL,
        properties,
        previousProperties,
        context,
        logicalId,
        resourceType
      );
      if (keptWarning !== undefined) this.logger.warn(keptWarning);

      return {
        physicalId,
        wasReplaced: false,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update DocDB DBInstance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DocDB DBInstance ${logicalId}: ${physicalId}`);

    // DocDB DBInstance does NOT have its own DeletionProtection field
    // (only the cluster does). `--remove-protection` is therefore a no-op
    // here — the existing delete logic runs unchanged. The cluster-level
    // bypass on DBCluster handles the "protect against accidental delete"
    // intent for instances inside a protected cluster.

    try {
      await this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
        })
      );

      this.logger.debug(`Successfully initiated deletion of DocDB DBInstance ${logicalId}`);

      // Wait for instance to be fully deleted
      await this.waitForInstanceDeleted(physicalId);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  DocDB DB instance ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`DocDB DBInstance ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete DocDB DBInstance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** go-to-k/cdkd#5380: mark each of `keys` the update sends, just before the call. */
  private markChangedUnsettled(
    keys: readonly string[],
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): void {
    for (const key of keys) {
      if (properties[key] != null && !isDeepStrictEqual(properties[key], previousProperties[key])) {
        context?.markUnsettled?.(key);
      }
    }
  }

  /** A refusal before any call: nothing reached AWS, and only key names are printed. */
  private refuseBlock(
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    text: string
  ): never {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType === 'AWS::DocDB::DBInstance' ? 'DocDB DBInstance' : 'DocDB DBCluster'} ${logicalId}: ${text}; nothing was changed.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  /**
   * The `EnableCloudwatchLogsExports` (`undefined` when absent) and
   * `ServerlessV2ScalingConfiguration` a create or update sends, malformed ones
   * refused before any call. A state-borne bag, which the template cannot fix,
   * downgrades to a warning and leaves the block out. One exception: a malformed
   * list on an UPDATE stays refused, since the list is read as a diff and read
   * as empty it would disable every log
   * (`.claude/rules/provider-aws-response-reads.md`, the list rule).
   */
  private readClusterBlocks(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string },
    creating: boolean
  ): {
    logTypes: string[] | undefined;
    scaling: { MinCapacity: number; MaxCapacity: number } | null | undefined;
  } {
    const leaveOut = (key: string): void => {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the recorded ${key} is unusable, so it is not sent.`
      );
    };
    const rawLogs = properties['EnableCloudwatchLogsExports'];
    let logTypes = rawLogs == null ? undefined : docdbStringList(rawLogs);
    if (rawLogs != null && logTypes === undefined) {
      if (!(creating && origin.stateBorne)) {
        this.refuseBlock(
          logicalId,
          resourceType,
          origin.physicalId,
          'EnableCloudwatchLogsExports must be a list of strings'
        );
      }
      leaveOut('EnableCloudwatchLogsExports');
      logTypes = undefined;
    }
    const scaling = docdbServerlessScaling(properties['ServerlessV2ScalingConfiguration']);
    if (scaling === null) {
      if (!origin.stateBorne) {
        this.refuseBlock(
          logicalId,
          resourceType,
          origin.physicalId,
          'ServerlessV2ScalingConfiguration must be an object with both a numeric MinCapacity and a numeric MaxCapacity'
        );
      }
      leaveOut('ServerlessV2ScalingConfiguration');
    }
    return { logTypes, scaling };
  }

  /**
   * go-to-k/cdkd#2762: what a cluster update sends for the master credentials.
   *
   * - The managed side is the record's flag. A record without one (never
   *   declared, or a deploy dropped it and the cluster stayed managed) reads
   *   `MasterUserSecret` when a password or the flag is about to go out, and only
   *   then; its ARN is never kept.
   * - The flag goes out on a change, or beside a key change.
   * - Leaving managed mode sends the declared password whether it changed or
   *   not: AWS refuses `false` without one.
   * - `drift --revert` never changes the mode, either way: its bags hold no
   *   password or key. A rollback turning management off with no password to
   *   send sends nothing. Both leave a warning for after the update.
   */
  private async planMasterCredentials(
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    context: UpdateContext | undefined,
    origin: { stateBorne: boolean; physicalId?: string }
  ): Promise<{
    managed: boolean | undefined;
    secretKmsKey: string | undefined;
    password: string | undefined;
    heldWarning: string | undefined;
  }> {
    const managed = this.readBooleanProperty(
      'ManageMasterUserPassword',
      properties,
      resourceType,
      logicalId,
      origin
    );
    const changedPassword = masterUserPasswordToSend(properties, previousProperties, context);
    const recordedFlag = coerceCfnBoolean(previousProperties['ManageMasterUserPassword']);
    let managedSide = recordedFlag ?? false;
    let heldKey = previousProperties['MasterUserSecretKmsKeyId'] as string | undefined;
    if (recordedFlag === undefined && (changedPassword !== undefined || managed !== undefined)) {
      const secret = (await this.describeDBCluster(physicalId))?.MasterUserSecret;
      managedSide = secret !== undefined;
      heldKey ??= secret?.KmsKeyId;
    }
    const leaving = managed === false && managedSide;
    const declared = properties['MasterUserPassword'];
    const declaredUsable =
      typeof declared === 'string' &&
      declared !== SECRET_MASK &&
      dynamicReferenceTokens(declared).length === 0;
    const password = leaving ? (declaredUsable ? declared : undefined) : changedPassword;
    const modeChange = managed !== undefined && managed !== managedSide;
    const held =
      context?.desiredFromAwsReadback === true && modeChange
        ? safeMsg`${logicalId} (${resourceType}): cdkd drift --revert does not change ManageMasterUserPassword, so it is left as it is. Declare it in the template and deploy to change it.`
        : origin.stateBorne && leaving && password === undefined
          ? safeMsg`${logicalId} (${resourceType}): ManageMasterUserPassword stays true: turning it off needs a MasterUserPassword, which the restored state does not hold. Declare both in the template and deploy.`
          : undefined;
    if (held !== undefined) {
      return {
        managed: undefined,
        secretKmsKey: undefined,
        password: undefined,
        heldWarning: held,
      };
    }
    const key = properties['MasterUserSecretKmsKeyId'] as string | undefined;
    // The key rides only turning management on or a change while it stays on:
    // AWS takes one only then, answers the second itself, and never beside false.
    const sendKey =
      key != null &&
      ((modeChange && managed === true) || (!sameKmsKey(key, heldKey) && (managed ?? managedSide)));
    return {
      managed: modeChange || sendKey ? managed : undefined,
      secretKmsKey: sendKey ? key : undefined,
      password: this.passwordBesideManaged(
        managed,
        managed === undefined && managedSide,
        password,
        resourceType,
        logicalId,
        origin
      ),
      heldWarning: undefined,
    };
  }

  /**
   * A boolean property as what it means, `undefined` when absent. Sending or
   * skipping a call hangs on it, so a value that is no boolean is refused before
   * any call, except from a state-borne bag: left out, with a warning.
   */
  private readBooleanProperty(
    key: 'ManageMasterUserPassword' | 'EnablePerformanceInsights',
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string }
  ): boolean | undefined {
    const value = properties[key];
    if (value == null) return undefined;
    const flag = coerceCfnBoolean(value);
    if (flag !== undefined) return flag;
    if (!origin.stateBorne) {
      this.refuseBlock(logicalId, resourceType, origin.physicalId, `${key} must be a boolean`);
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded ${key} is unusable, so it is not sent.`
    );
    return undefined;
  }

  /**
   * go-to-k/cdkd#2762: the password a call carries beside
   * `ManageMasterUserPassword`. AWS manages that password, so a call asking for
   * both is never sent: refused before any call rather than dropping a password
   * the template spelled, and from a state-borne bag the password is left out.
   * `removedFromManaged` is the same conflict with the flag gone from the
   * template and the record managed: sending `false` too would delete the AWS
   * secret on a path no A/B measured, so leaving takes an explicit `false`. An
   * unchanged password on an update is already `undefined` here. The value is
   * never printed.
   */
  private passwordBesideManaged(
    managed: boolean | undefined,
    removedFromManaged: boolean,
    password: string | undefined,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string }
  ): string | undefined {
    if ((managed !== true && !removedFromManaged) || password == null) return password;
    if (!origin.stateBorne) {
      this.refuseBlock(
        logicalId,
        resourceType,
        origin.physicalId,
        removedFromManaged
          ? 'MasterUserPassword cannot change while AWS manages the password; declare ManageMasterUserPassword: false beside it to leave managed mode'
          : 'MasterUserPassword cannot be set while ManageMasterUserPassword is true, because AWS manages that password'
      );
    }
    this.logger.warn(
      removedFromManaged
        ? safeMsg`${logicalId} (${resourceType}): the recorded MasterUserPassword is not sent: the cluster stays managed, because the recorded ManageMasterUserPassword is absent.`
        : safeMsg`${logicalId} (${resourceType}): the recorded MasterUserPassword is not sent, because ManageMasterUserPassword is true.`
    );
    return undefined;
  }

  /**
   * Poll until each change AWS accepted reads back, so the observed baseline the
   * engine captures after update() does not record the old value (phantom
   * drift). No key: no call. The change was accepted, so the cap (the tighter
   * of `maxWaitMs` and what the resource deadline leaves) is a warning naming
   * the keys still old, not a failure. The baseline then keeps that old value,
   * which outlives the change landing, so the warning says how to refresh it.
   */
  private async waitForApplied<T>(
    logicalId: string,
    applied: ReadonlyMap<string, (live: T | undefined) => boolean>,
    read: () => Promise<T | undefined>,
    maxWaitMs = SETTLE_MAX_WAIT_MS
  ): Promise<void> {
    if (applied.size === 0) return;
    const capMs = Math.min(maxWaitMs, enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS);
    const startTime = Date.now();
    let delay = 2_000;
    for (;;) {
      const live = await read();
      const pending = [...applied].filter(([, isApplied]) => !isApplied(live));
      if (pending.length === 0) return;
      if (Date.now() - startTime + delay >= capMs) {
        const keys = pending.map(([key]) => key).join(', ');
        this.logger.warn(
          safeMsg`${logicalId}: the new ${keys} did not read back when cdkd stopped waiting; AWS accepted the change, so cdkd drift may report the old value as the baseline. Once it applies, run cdkd drift --accept.`
        );
        return;
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private async describeDBCluster(dbClusterIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: dbClusterIdentifier,
      })
    );
    return response.DBClusters?.[0];
  }

  private async describeDBInstance(dbInstanceIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
      })
    );
    return response.DBInstances?.[0];
  }

  /**
   * go-to-k/cdkd#4606: whether the DocDB DB cluster or DB instance a failed
   * CREATE journaled is the one the record under the same logical id holds (a
   * fix-forward that created a new one there under another identifier).
   *
   * Reached on the SDK route only (`disableCcApiFallback`: these types have no
   * Cloud Control route). Both ids must be DB identifiers; anything else is
   * `'unknown'`. An identifier names at most one cluster (or instance) per
   * account and region at a time, in a namespace DocumentDB shares with RDS
   * and Neptune, and identifiers compare case-insensitively (stored
   * lower-cased), so two spellings equal modulo case are `'same'` without a
   * read. After the region check the record's resource must read back (else
   * `'unknown'`); the journaled one is `'same'` when it reads back under the
   * record's `DbClusterResourceId` / `DbiResourceId` (immutable, unique),
   * `'different'` under another, and `'different'` when AWS reports its
   * identifier gone: the record's resource answers to its own, other,
   * identifier. A read answering with another engine's resource (the shared
   * describe returns RDS and Neptune resources too) throws, which the caller
   * reads as `'unknown'`: this provider's delete would remove that resource.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::DocDB::DBCluster' && resourceType !== 'AWS::DocDB::DBInstance') {
      return 'unknown';
    }
    if (!isDbIdentifier(journaledPhysicalId) || !isDbIdentifier(record.physicalId)) {
      return 'unknown';
    }
    if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'same';
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordResourceId = await this.readDbResourceIdIfExists(resourceType, record.physicalId);
    if (recordResourceId === undefined) return 'unknown';
    const journaledResourceId = await this.readDbResourceIdIfExists(
      resourceType,
      journaledPhysicalId
    );
    if (journaledResourceId === undefined) return 'different';
    return journaledResourceId === recordResourceId ? 'same' : 'different';
  }

  /**
   * go-to-k/cdkd#4606: the cluster's `DbClusterResourceId` or the instance's
   * `DbiResourceId`, which AWS generates, never changes and never gives a
   * later resource. A resource re-created under the identifier, by any engine
   * and in any case spelling, answers with another id (or, for another
   * engine, throws), so the settle keeps it rather than deleting it as the
   * failed CREATE's orphan. A failed CREATE's own token comes from its create
   * response, on the failure's mark (`markCreatedBeforeFailure`); this is the
   * live read.
   *
   * `undefined` for another type, an id that is not a DB identifier, or a
   * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND` only
   * on the describe's not-found fault NAME (or an empty list); any other
   * failure throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::DocDB::DBCluster' && resourceType !== 'AWS::DocDB::DBInstance') {
      return undefined;
    }
    if (!isDbIdentifier(physicalId)) return undefined;
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
    return live === undefined ? RESOURCE_NOT_FOUND : live;
  }

  /**
   * The DocDB cluster's `DbClusterResourceId` (or the instance's
   * `DbiResourceId`), or `undefined` when AWS reports the identifier gone (its
   * not-found fault NAME, or an empty describe list). Any other failure, a
   * response naming another identifier, another engine than `docdb`, or no
   * resource id throws: "could not read" never reads as "gone", and an RDS or
   * Neptune resource under the identifier is never this provider's.
   */
  private async readDbResourceIdIfExists(
    resourceType: 'AWS::DocDB::DBCluster' | 'AWS::DocDB::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    const isCluster = resourceType === 'AWS::DocDB::DBCluster';
    let found:
      | {
          identifier: string | undefined;
          engine: string | undefined;
          resourceId: string | undefined;
        }
      | undefined;
    try {
      if (isCluster) {
        const cluster = await this.describeDBCluster(identifier);
        found = cluster && {
          identifier: cluster.DBClusterIdentifier,
          engine: cluster.Engine,
          resourceId: cluster.DbClusterResourceId,
        };
      } else {
        const instance = await this.describeDBInstance(identifier);
        found = instance && {
          identifier: instance.DBInstanceIdentifier,
          engine: instance.Engine,
          resourceId: instance.DbiResourceId,
        };
      }
    } catch (error) {
      const notFound = isCluster ? 'DBClusterNotFoundFault' : 'DBInstanceNotFoundFault';
      if ((error as { name?: unknown } | null)?.name === notFound) return undefined;
      throw error;
    }
    if (found === undefined) return undefined;
    const api = isCluster ? 'DescribeDBClusters' : 'DescribeDBInstances';
    if (found.identifier?.toLowerCase() !== identifier.toLowerCase()) {
      throw new Error(`${api} answered for another identifier`);
    }
    if (found.engine !== 'docdb') {
      throw new Error(`${api} answered with a resource of another engine`);
    }
    if (typeof found.resourceId !== 'string' || found.resourceId === '') {
      throw new Error(`${api} returned no resource id`);
    }
    return found.resourceId;
  }

  /**
   * Issue #1160: wait out a member instance's transition (`transitional`) after
   * its cluster's security groups or port changed. Only that transition is
   * waited out: a member in a lasting state (maintenance, upgrading,
   * storage-optimization, ...) or deleted out of band does not hold the update,
   * as CloudFormation reports the cluster updated in those cases too.
   */
  private async waitForMemberAfterClusterChange(
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    transitional: ReadonlySet<string>,
    change: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      let status: string | undefined;
      try {
        status = (await this.describeDBInstance(dbInstanceIdentifier))?.DBInstanceStatus;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) return;
        throw error;
      }
      if (status === undefined || !transitional.has(status)) return;
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    // The member's identifier is the physical id of ANOTHER resource, which
    // this cluster's masking bag does not cover (it can be secret-derived), so
    // only the cluster's logical id is named.
    throw new Error(
      safeMsg`Timed out waiting for a member instance of DocDB DBCluster ${clusterLogicalId} to finish applying its new ${change}`
    );
  }

  /**
   * A cluster read inside an update wait (issues #5411, #5419). A vanished
   * cluster or a terminal status (`isTerminalDbWaitStatus`) never reaches the
   * awaited state, so fail now rather than after the 30-minute budget.
   */
  private requireClusterWhileWaiting(
    cluster: DBCluster | undefined,
    logicalId: string,
    change: string
  ): DBCluster {
    // A deleted cluster usually throws DBClusterNotFoundFault from the describe
    // itself; this arm covers an empty `DBClusters` list.
    if (cluster === undefined) {
      throw new Error(
        safeMsg`DescribeDBClusters returned no cluster for DocDB DBCluster ${logicalId} while waiting for its new ${change}`
      );
    }
    if (isTerminalDbWaitStatus(cluster.Status)) {
      throw new Error(
        safeMsg`DocDB DBCluster ${logicalId} entered status ${cluster.Status ?? ''} while applying its new ${change}`
      );
    }
    return cluster;
  }

  /**
   * Wait until the cluster is out of `modifying` and reports `port` (issue
   * #1160). `available` alone can still read before the port change starts;
   * the port cannot.
   */
  private async waitForClusterPortApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    port: number,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const cluster = this.requireClusterWhileWaiting(
        await this.describeDBCluster(dbClusterIdentifier),
        logicalId,
        'port'
      );
      if (cluster.Status !== 'modifying' && cluster.Port === port) return;
      this.logger.debug(
        safeMsg`DocDB DBCluster ${logicalId} port not applied yet (status ${cluster.Status ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(`Timed out waiting for DocDB DBCluster ${logicalId} to apply its new port`);
  }

  /**
   * Wait until the cluster is out of `modifying` AND reports exactly `expected` as
   * its VPC security groups, all `active` (issue #1160). Being out of
   * `modifying` alone can still read before the group swap has started; the
   * group statuses cannot.
   */
  private async waitForSecurityGroupsApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    expected: readonly string[],
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const want = [...new Set(expected)].sort().join(' ');
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const cluster = this.requireClusterWhileWaiting(
        await this.describeDBCluster(dbClusterIdentifier),
        logicalId,
        'VPC security groups'
      );
      const groups = cluster.VpcSecurityGroups ?? [];
      const ids = groups
        .map((group) => group.VpcSecurityGroupId ?? '')
        .sort()
        .join(' ');
      // `modifying` is the swap's own transition; any lasting state (backing-up,
      // maintenance, ...) is not this change's to wait out.
      const settled =
        cluster.Status !== 'modifying' &&
        groups.every((group) => group.Status === 'active') &&
        ids === want;
      if (settled) return;
      this.logger.debug(
        safeMsg`DocDB DBCluster ${logicalId} security groups not settled yet (status ${cluster.Status ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(
      `Timed out waiting for DocDB DBCluster ${logicalId} to apply its new VPC security groups`
    );
  }

  /**
   * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
   * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
   * and their bounds).
   */
  private async deleteAfterProtectionFlip(
    logicalId: string,
    physicalId: string,
    send: () => Promise<unknown>
  ): Promise<void> {
    await deleteAfterProtectionFlipWithFinalSnapshot({
      stateFault: 'InvalidDBClusterStateFault',
      send,
      noun: 'cluster',
      label: 'DocDB DBCluster',
      logicalId,
      read: async () => {
        const current = await this.describeDBCluster(physicalId);
        return current === undefined
          ? undefined
          : { deletionProtection: current.DeletionProtection, status: current.Status };
      },
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      remainingMs: enclosingDeadlineRemainingMs(),
    });
  }

  /**
   * Wait for a DocDB DBCluster to become available. DocDB's SDK does not ship
   * a `waitUntilDBClusterAvailable` waiter (only DBInstance has waiters), so
   * Status is polled with exponential backoff. A terminal status
   * (`isTerminalDbWaitStatus`) fails at once rather than after the
   * 30-minute budget (issue #5426).
   */
  private async waitForClusterAvailable(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`DocDB DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;
      // Issue #5426: a terminal status never becomes 'available'.
      if (isTerminalDbWaitStatus(status)) {
        throw new Error(
          safeMsg`DocDB DBCluster ${logicalId} entered status ${status ?? ''} while being created, which it does not leave on its own`
        );
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for DocDB DBCluster ${dbClusterIdentifier} to become available`
    );
  }

  /**
   * Wait for a DBCluster to be deleted (no SDK waiter — manual poll).
   */
  private async waitForClusterDeleted(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeDBCluster(dbClusterIdentifier);
        const status = cluster?.Status;

        this.logger.debug(`DocDB DBCluster ${logicalId} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DocDB DBCluster ${logicalId} to be deleted`);
  }

  /**
   * Wait for a DocDB DBInstance to become available. A terminal status
   * (`isTerminalDbWaitStatus`) fails at once rather than after the
   * 30-minute budget (issue #5426).
   */
  private async waitForInstanceAvailable(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;
      // Issue #5426: a terminal status never becomes 'available'.
      if (isTerminalDbWaitStatus(status)) {
        throw new Error(
          safeMsg`DocDB DBInstance ${logicalId} entered status ${status ?? ''} while being created, which it does not leave on its own`
        );
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to become available`
    );
  }

  private async waitForInstanceDeleted(
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const instance = await this.describeDBInstance(dbInstanceIdentifier);
        const status = instance?.DBInstanceStatus;

        this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * What no read answers for drift. `RotateMasterUserPassword` and
   * `CertificateRotationRestart` are per-call requests. `AvailabilityZones` is
   * create-only, and DescribeDBClusters reports the zones AWS placed the cluster
   * in. `MasterUserSecretKmsKeyId` may be declared as an alias or key id, where
   * the read answers one spelling.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::DocDB::DBCluster') {
      return ['AvailabilityZones', 'MasterUserSecretKmsKeyId', 'RotateMasterUserPassword'];
    }
    if (resourceType === 'AWS::DocDB::DBInstance') return ['CertificateRotationRestart'];
    return [];
  }

  /** A set to AWS, answered in its own order; `unsettledAfterUpdate` compares by it too. */
  getDriftUnorderedPaths(resourceType: string): string[] {
    return resourceType === 'AWS::DocDB::DBCluster' ? ['EnableCloudwatchLogsExports'] : [];
  }

  /**
   * What the comparator cannot see: a repeated log type reads as the same list,
   * and a CFn capacity may be a numeric string. A malformed side is left alone.
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::DocDB::DBCluster') return properties;
    const out = { ...properties };
    const logs = out['EnableCloudwatchLogsExports'];
    if (Array.isArray(logs) && docdbStringList(logs) !== undefined) {
      out['EnableCloudwatchLogsExports'] = [...new Set(logs as string[])];
    }
    const scaling = docdbServerlessScaling(out['ServerlessV2ScalingConfiguration']);
    if (scaling != null) out['ServerlessV2ScalingConfiguration'] = scaling;
    return out;
  }

  /** The post-update proof compares through the same normalization. */
  canonicalizeUnsettledProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return this.canonicalizeDriftProperties(resourceType, properties);
  }

  /**
   * go-to-k/cdkd#5487: the live values of a record's unsettled names. The log
   * list keeps only the types the record, the template or an earlier attempt
   * (#5498) names: the convergence puts this on the previous side, so a type an
   * out-of-band change enabled would otherwise read as dropped, and be disabled.
   */
  async readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const live = await this.readCurrentState(physicalId, logicalId, resourceType);
    if (resourceType !== 'AWS::DocDB::DBCluster') return live;
    if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
    if (!names.has('EnableCloudwatchLogsExports')) return live;
    const key = 'EnableCloudwatchLogsExports';
    const named = new Set([
      ...(docdbStringList(recordedProperties?.[key]) ?? []),
      ...(docdbStringList(desiredProperties?.[key]) ?? []),
      ...[...(attemptedItems?.get(key) ?? [])].filter(isUsableAttemptedName),
    ]);
    return { ...live, [key]: ((live[key] ?? []) as string[]).filter((type) => named.has(type)) };
  }

  /**
   * go-to-k/cdkd#5380: every name while AWS is still changing the resource. A
   * backup moves nothing, so it does not hold a deploy back. After a successful
   * update (`desiredProperties` present) nothing is reported: the caller's
   * comparison of each value with the template is the proof. A failed read
   * keeps every name.
   */
  async unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    _recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>
  ): Promise<ReadonlySet<string>> {
    if (desiredProperties !== undefined) return new Set();
    const unmoving = (status: string | undefined): boolean =>
      isProceedDbStatus(status) || status === 'backing-up';
    try {
      if (resourceType === 'AWS::DocDB::DBCluster') {
        const cluster = await this.describeDBCluster(physicalId);
        return unmoving(cluster?.Status) ? new Set() : names;
      }
      if (resourceType === 'AWS::DocDB::DBInstance') {
        const instance = await this.describeDBInstance(physicalId);
        const settled =
          unmoving(instance?.DBInstanceStatus) &&
          !holdsDocDBPendingValue(instance?.PendingModifiedValues);
        return settled ? new Set() : names;
      }
      return new Set();
    } catch {
      return names;
    }
  }

  /**
   * Adopt an existing DocDB resource into cdkd state.
   *
   * Supported types: `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`.
   * Identifier name properties (`DBInstanceIdentifier` /
   * `DBClusterIdentifier`) are usually
   * present in CDK templates and are resolved via the corresponding
   * `Describe*` existence check. There is no `aws:cdk:path` tag fallback:
   * AWS rejects `aws:`-prefixed tag writes, so that tag never exists on a
   * real resource and the walk could not match (issue #1134).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::DocDB::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::DocDB::DBCluster':
        return this.importDBCluster(input);
      default:
        return null;
    }
  }

  /**
   * Read the AWS-current DocDB resource configuration in CFn-property shape.
   *
   * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
   * fields like `MasterUserPassword` are NEVER surfaced (DocDB does not
   * return them in the Describe responses), and of `MasterUserSecret` only
   * whether one exists: its ARN is not a property. `Tags` are surfaced via a
   * follow-up `ListTagsForResource(ResourceName=arn)` call.
   *
   * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`*NotFoundFault`
   * or an empty describe list), `undefined` for a type with no read path.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::DocDB::DBInstance':
        return this.readCurrentStateDBInstance(physicalId);
      case 'AWS::DocDB::DBCluster':
        return this.readCurrentStateDBCluster(physicalId);
      default:
        return undefined;
    }
  }

  private async readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let inst;
    try {
      inst = await this.describeDBInstance(physicalId);
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBInstanceNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (isDocDBNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
      throw err;
    }
    if (!inst) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (inst.DBInstanceIdentifier !== undefined) {
      result['DBInstanceIdentifier'] = inst.DBInstanceIdentifier;
    }
    if (inst.DBInstanceClass !== undefined) result['DBInstanceClass'] = inst.DBInstanceClass;
    if (inst.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = inst.DBClusterIdentifier;
    }
    if (inst.AvailabilityZone !== undefined) result['AvailabilityZone'] = inst.AvailabilityZone;
    if (inst.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = inst.PreferredMaintenanceWindow;
    }
    if (inst.AutoMinorVersionUpgrade !== undefined) {
      result['AutoMinorVersionUpgrade'] = inst.AutoMinorVersionUpgrade;
    }
    if (inst.CACertificateIdentifier !== undefined) {
      result['CACertificateIdentifier'] = inst.CACertificateIdentifier;
    }
    result['EnablePerformanceInsights'] = inst.PerformanceInsightsEnabled ?? false;
    if (inst.DBInstanceArn)
      await attachDocDBTags(this.getClient(), this.logger, result, inst.DBInstanceArn);
    return result;
  }

  private async readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let cluster;
    try {
      cluster = await this.describeDBCluster(physicalId);
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBClusterNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (isDocDBNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (cluster.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
    }
    if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
    if (cluster.MasterUsername !== undefined) result['MasterUsername'] = cluster.MasterUsername;
    if (cluster.Port !== undefined) result['Port'] = cluster.Port;
    result['VpcSecurityGroupIds'] = (cluster.VpcSecurityGroups ?? [])
      .map((sg) => sg.VpcSecurityGroupId)
      .filter((id): id is string => !!id);
    if (cluster.DBSubnetGroup !== undefined) result['DBSubnetGroupName'] = cluster.DBSubnetGroup;
    if (cluster.StorageEncrypted !== undefined) {
      result['StorageEncrypted'] = cluster.StorageEncrypted;
    }
    if (cluster.KmsKeyId !== undefined) result['KmsKeyId'] = cluster.KmsKeyId;
    if (cluster.BackupRetentionPeriod !== undefined) {
      result['BackupRetentionPeriod'] = cluster.BackupRetentionPeriod;
    }
    if (cluster.PreferredBackupWindow !== undefined) {
      result['PreferredBackupWindow'] = cluster.PreferredBackupWindow;
    }
    if (cluster.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
    }
    if (cluster.DBClusterParameterGroup !== undefined) {
      result['DBClusterParameterGroupName'] = cluster.DBClusterParameterGroup;
    }
    if (cluster.DeletionProtection !== undefined) {
      result['DeletionProtection'] = cluster.DeletionProtection;
    }
    // The drift walk compares recorded keys only, so these read nothing for an
    // older record. Absent on the wire means the default for the three below.
    result['CopyTagsToSnapshot'] = cluster.CopyTagsToSnapshot ?? false;
    result['ManageMasterUserPassword'] = cluster.MasterUserSecret !== undefined;
    result['StorageType'] = cluster.StorageType ?? DOCDB_DEFAULT_STORAGE_TYPE;
    result['EnableCloudwatchLogsExports'] = cluster.EnabledCloudwatchLogsExports ?? [];
    if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
    const { MinCapacity: min, MaxCapacity: max } = cluster.ServerlessV2ScalingConfiguration ?? {};
    if (min !== undefined && max !== undefined) {
      result['ServerlessV2ScalingConfiguration'] = { MinCapacity: min, MaxCapacity: max };
    }
    if (cluster.DBClusterArn)
      await attachDocDBTags(this.getClient(), this.logger, result, cluster.DBClusterArn);
    return result;
  }

  private async importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
        );
        // The map `create()` records, from the describe this verification
        // already issues (issue #1852). It is what heals a record written
        // under `--no-wait` while the instance was still `creating`
        // (go-to-k/cdkd#3077): the deploy engine re-reads through `import()`
        // when a `Fn::GetAtt` misses. `definedAttributes` keeps an unassigned
        // endpoint ABSENT, so a still-`creating` instance heals nothing.
        const described = resp.DBInstances?.[0];
        return {
          physicalId: explicit,
          attributes: instanceAttributes(described),
        };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: the tag never exists on a real resource
    // (issue #1134). A DBInstance reaching here needs an explicit `--resource`
    // override or a `DBInstanceIdentifier` in the template.
    return null;
  }

  private async importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
        );
        // Issue #3627: the same map `create()` records.
        return { physicalId: explicit, attributes: clusterAttributes(resp.DBClusters?.[0]) };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: the tag never exists on a real resource
    // (issue #1134). A DBCluster reaching here needs an explicit `--resource`
    // override or a `DBClusterIdentifier` in the template.
    return null;
  }
}

/**
 * Whether the VpcSecurityGroupIds a cluster update SENDS differs from the
 * previous template's list (order-insensitive). `sent === undefined` sends
 * nothing, so nothing changes.
 */
function securityGroupListChanged(sent: readonly string[] | undefined, previous: unknown): boolean {
  if (sent === undefined) return false;
  const before = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string')
    : [];
  return [...sent].sort().join(' ') !== [...before].sort().join(' ');
}
