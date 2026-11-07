import { maskerOrIdentity } from '../masked-retry-logger.js';
import {
  RDSClient,
  DeregisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
  DescribeDBProxyTargetsCommand,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
} from '@aws-sdk/client-rds';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceNotFound,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { isAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { retractCreatedResource } from '../created-resource-sink.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import type { TargetListKind } from './rds-dbproxy-targetgroup/shared.js';
import { create } from './rds-dbproxy-targetgroup/create.js';
import { update } from './rds-dbproxy-targetgroup/update.js';
import { deleteImpl } from './rds-dbproxy-targetgroup/delete.js';
import { readCurrentState, importImpl } from './rds-dbproxy-targetgroup/read-state.js';

export {
  MALFORMED_TARGETS_SKIP_REASON,
  NON_DEFAULT_GROUP_SKIP_REASON,
} from './rds-dbproxy-targetgroup/shared.js';

/**
 * AWS RDS DBProxyTargetGroup Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxyTargetGroup`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * pre-PR this type went through Cloud Control API, but CC API's resource
 * handler for `AWS::RDS::DBProxyTargetGroup` fails the delete path with
 * `Value null at 'dBProxyName' failed to satisfy constraint`. The handler
 * cannot derive `DBProxyName` from the TargetGroup ARN (the primary
 * identifier), so the underlying RDS API call goes out with
 * `DBProxyName: null` and AWS rejects it (Issue #385).
 *
 * **What this resource actually does on AWS**: a CFn
 * `AWS::RDS::DBProxyTargetGroup` is a wiring resource — every DBProxy gets
 * a default TargetGroup (`TargetGroupName: 'default'`) auto-created by AWS;
 * the CFn resource only manages target REGISTRATIONS
 * (`RegisterDBProxyTargets` / `DeregisterDBProxyTargets`) and the
 * connection pool config (`ModifyDBProxyTargetGroup`). The TargetGroup
 * object itself is not deleted on resource delete — it lives and dies with
 * the parent DBProxy.
 *
 * **Lifecycle**:
 * - `create`: optionally `ModifyDBProxyTargetGroup` (connection pool), then
 *   `RegisterDBProxyTargets` (cluster IDs and / or instance IDs), then
 *   `DescribeDBProxyTargetGroups` to recover the TargetGroupArn for state,
 *   then `AddTagsToResource` on that ARN when `Tags` is declared (the schema
 *   is `tagOnCreate: false`, so tagging is always a separate call).
 * - `update`: `ModifyDBProxyTargetGroup` for a pool config change, then
 *   `DeregisterDBProxyTargets` / `RegisterDBProxyTargets` for the target
 *   diff, then the `Tags` diff; a `DBProxyName` / `TargetGroupName` change is
 *   rejected via `ResourceUpdateNotSupportedError`.
 * - `delete`: `DeregisterDBProxyTargets` for every registered target.
 *   `DBProxyNotFoundFault` / `DBProxyTargetGroupNotFoundFault` /
 *   `DBProxyTargetNotFoundFault` are treated as idempotent success
 *   (region-match-gated) — the parent DBProxy may already have been
 *   deleted by a sibling cdkd delete or by AWS CASCADE.
 * - Every method that names a target reads both target lists through
 *   `readTargetLists` first and refuses (or, on delete, skips) a malformed one
 *   before any AWS call (go-to-k/cdkd#3945).
 * - `getAttribute`: `TargetGroupArn` returns the physicalId; `TargetGroupName`
 *   returns `'default'`.
 *
 * **physicalId** = TargetGroupArn (matches the CFn `primaryIdentifier`).
 */
export class RDSDBProxyTargetGroupProvider implements ResourceProvider {
  rdsClient?: RDSClient;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('RDSDBProxyTargetGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxyTargetGroup',
      new Set([
        'DBProxyName',
        'TargetGroupName',
        'DBClusterIdentifiers',
        'DBInstanceIdentifiers',
        'ConnectionPoolConfigurationInfo',
        'Tags',
      ]),
    ],
  ]);

  getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.rdsClient;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- attribute resolution does not need AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TargetGroupArn':
        return physicalId;
      case 'TargetGroupName':
        return 'default';
      default:
        this.logger.warn(
          `Unknown attribute ${attributeName} for AWS::RDS::DBProxyTargetGroup, returning undefined`
        );
        return undefined;
    }
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType, properties);
  }

  /**
   * Deregister what a failing `create()` registered, then hand back the
   * ORIGINAL error — with the manual command appended when the cleanup
   * itself fails. With `leftBehind` (the target group's ARN, once known),
   * that failure also marks the error for the failed-CREATE journal
   * (go-to-k/cdkd#4583); a successful deregister leaves nothing to mark.
   */
  async retireRegistrationAfterFailedCreate(
    original: ProvisioningError,
    dbProxyName: string,
    targetGroupName: string,
    dbClusterIdentifiers: string[] | undefined,
    dbInstanceIdentifiers: string[] | undefined,
    maskSecrets: ((text: string) => string) | undefined,
    leftBehind?: {
      logicalId: string;
      resourceType: string;
      physicalId: string;
    }
  ): Promise<ProvisioningError> {
    const clusters = dbClusterIdentifiers?.length ? dbClusterIdentifiers : undefined;
    const instances = dbInstanceIdentifiers?.length ? dbInstanceIdentifiers : undefined;
    if (!clusters && !instances) return original;
    try {
      await this.getClient().send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: clusters,
          DBInstanceIdentifiers: instances,
        })
      );
      if (leftBehind) {
        retractCreatedResource(
          leftBehind.logicalId,
          leftBehind.resourceType,
          leftBehind.physicalId
        );
      }
      return original;
    } catch (cleanupError) {
      // Template-chosen names, so the command renders through
      // `pasteableAwsCommand` (issue #3136) and is withheld rather than
      // printed inexactly.
      const aws = pasteableAwsCommand(maskSecrets);
      let targets = aws``;
      if (clusters) {
        targets = aws`${targets} --db-cluster-identifiers`;
        for (const id of clusters) targets = aws`${targets} ${id}`;
      }
      if (instances) {
        targets = aws`${targets} --db-instance-identifiers`;
        for (const id of instances) targets = aws`${targets} ${id}`;
      }
      // The appended text is persisted with the original's, so AWS's own
      // wording goes to `debug` and the message names its class (issue #2319).
      const cleanupFailure = describeAwsFailure(cleanupError);
      if (cleanupFailure.redacted) {
        this.logger.debug(
          maskerOrIdentity(maskSecrets)(
            `Deregistering the targets a failed create registered failed: ${cleanupFailure.detail}`
          )
        );
      }
      original.message +=
        ` The targets this create registered are still registered and could not be ` +
        `deregistered (${maskerOrIdentity(maskSecrets)(cleanupFailure.summary).replace(/\.$/, '')}). Manual cleanup: ` +
        aws`aws rds deregister-db-proxy-targets --db-proxy-name ${dbProxyName} --target-group-name ${targetGroupName}${targets}`.render();
      if (leftBehind) {
        markCreatedBeforeFailure(
          original,
          leftBehind.logicalId,
          leftBehind.resourceType,
          leftBehind.physicalId
        );
      }
      return original;
    }
  }

  /**
   * Whether `delete()` may read the parent as already gone, from
   * `DescribeDBProxyTargetGroups`. With a `targetGroupName`, a missing proxy OR
   * group counts; without one (the recorded name is not `default`, so a group
   * NotFound would prove nothing), only a missing proxy does. A NotFound is
   * region-gated like every other idempotent arm; any other outcome is `false`,
   * and a failed probe is logged at debug so the skip that follows is
   * traceable.
   */
  async proxyConfirmedGone(
    dbProxyName: string,
    targetGroupName: string | undefined,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    context: DeleteContext | undefined
  ): Promise<boolean> {
    try {
      await this.getClient().send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          ...(targetGroupName !== undefined ? { TargetGroupName: targetGroupName } : {}),
        })
      );
      return false;
    } catch (error) {
      if (
        error instanceof DBProxyNotFoundFault ||
        (targetGroupName !== undefined && error instanceof DBProxyTargetGroupNotFoundFault)
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        // The names are state-borne and can be a plaintext an in-process
        // rollback resolved, so each is masked as a value (go-to-k/cdkd#2007).
        const mask = maskerOrIdentity(context?.maskSecrets);
        this.logger.debug(
          mask(
            `${mask(dbProxyName)}/${targetGroupName === undefined ? '*' : mask(targetGroupName)} is already gone; the record needs no deregistration`
          )
        );
        return true;
      }
      this.logger.debug(
        safeMsg`Could not confirm whether the proxy of DB proxy target group ${logicalId} still exists (${error instanceof Error ? error.name : 'unknown error'}); keeping the skip`
      );
      return false;
    }
  }

  /**
   * The proxy target group's registered targets as the two CFn lists, from
   * `DescribeDBProxyTargets`. Shared by `readCurrentState` and `update()`'s
   * secret-derived recorded side; throws whatever the call throws.
   */
  async readLiveTargets(
    dbProxyName: string,
    targetGroupName: string
  ): Promise<Record<TargetListKind, string[]>> {
    const live: Record<TargetListKind, string[]> = {
      DBClusterIdentifiers: [],
      DBInstanceIdentifiers: [],
    };
    let marker: string | undefined;
    do {
      const targetsResp = await this.getClient().send(
        new DescribeDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          ...(marker ? { Marker: marker } : {}),
        })
      );
      for (const target of targetsResp.Targets ?? []) {
        const id = target.RdsResourceId;
        if (!id) continue;
        if (target.Type === 'TRACKED_CLUSTER') {
          live.DBClusterIdentifiers.push(id);
        } else if (target.Type === 'RDS_INSTANCE' && !target.TrackedClusterId) {
          // A member instance of a registered cluster is listed as its own
          // `RDS_INSTANCE` target carrying `TrackedClusterId`; it is the
          // cluster's registration, not a `DBInstanceIdentifiers` entry.
          live.DBInstanceIdentifiers.push(id);
        }
        // `RDS_SERVERLESS_ENDPOINT` targets are silently skipped — the
        // CFn `AWS::RDS::DBProxyTargetGroup` schema has no input slot for
        // them (only `DBClusterIdentifiers` / `DBInstanceIdentifiers`),
        // so they can't drift on a cdkd-managed target group.
      }
      marker = targetsResp.Marker;
    } while (marker);
    return live;
  }

  /**
   * The `ProvisioningError` a failed create, update or delete call throws
   * (issue #2319). Its message is persisted to `deployments/{runId}.jsonl`,
   * and an RDS `AccessDenied` names the caller's assumed-role ARN, so an
   * AWS-authored failure is named by its class plus the `--verbose` pointer:
   * AWS's own text goes to `debug` through the operation's masker, the
   * original error stays the `cause`, and the wrap is stamped
   * `markRedactedCause` so the retry classifiers read the withheld text on
   * that chain. An "already exists" is restated ({@link relayedNameCollision})
   * unless an auxiliary call raised it ({@link isAuxiliaryFailure}). A
   * cdkd-authored or transport error keeps its text, masked, stamped only when
   * the mask changed it (`wrapMaskedAwsError`); a non-`Error` throw is withheld
   * like an AWS one, unstamped (it has no chain). The delete catch tests
   * not-found by type before it wraps.
   */
  wrapError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    mask: (text: string) => string
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    const build = (text: string): ProvisioningError =>
      new ProvisioningError(
        `${op} failed for ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(`${mask(failure.summary)}${relay}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }
}
