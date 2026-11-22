import {
  DynamoDBClient,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  GetResourcePolicyCommand,
  PolicyNotFoundException,
  ResourceNotFoundException,
  TableNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { definedAttributes } from '../../attribute-map.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
} from '../../../deployment/retryable-errors.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import {
  readStreamPolicy,
  readTablePolicy,
  reverseMapReplicaContributorInsights,
  reverseMapReplicaPitr,
} from '../../dynamodb-replica-settings.js';
import {
  declaredStreamPolicyMember as declaredPolicyMember,
  reverseMapStreamPolicy as reverseMapPolicyMember,
  streamPolicyMatchesDeclared as policyMatchesDeclared,
} from '../../dynamodb-stream-members.js';
import { strictFor } from './projection.js';
import { autoScalingResourceId, type DynamoDBScalableDimension } from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import {
  type ReadTag,
  settleWrittenTags,
  takeTagWrite,
  type TagWrite,
} from '../../tags-own-write-baseline.js';
import { warnUnsettledMember } from '../../settle-after-own-write.js';

/**
 * Read per-replica sub-specifications against the given `DynamoDBClient`
 * (which may be the local client or a per-region client returned by
 * `getRegionalClient`):
 *  - `ContributorInsightsSpecification` via `DescribeContributorInsights`
 *    (table-level; GSI overrides are NOT surfaced in v1 — they would
 *    require one call per GSI and a different CFn nesting under the
 *    `Replicas[].GlobalSecondaryIndexes[]` shape).
 *  - `PointInTimeRecoverySpecification` via `DescribeContinuousBackups`.
 *  - `KinesisStreamSpecification` via
 *    `DescribeKinesisStreamingDestination` (filtered to the local
 *    region's destination when AWS reports more than one).
 *
 * A replica region's not-found (`ResourceNotFoundException`, or
 * `TableNotFoundException` from `DescribeContinuousBackups`) omits the key:
 * the replica is being created or removed. Any other failure throws
 * (go-to-k/cdkd#6759), so `cdkd drift` reports `readFailed` instead of leaving
 * the key uncompared — except on a replica AWS is not serving (`served`
 * false: CREATION_FAILED, REGION_DISABLED, an inaccessible key, ...), whose
 * reads stay tolerant, as `replicaStrictness` keeps them for the deploy that
 * recovers it.
 *
 * Issue #389 lifted the LOCAL-only limitation by parameterizing the
 * client — the same reverse-mapping logic runs against any region's
 * client.
 */
export async function readReplicaSubSpecs(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string,
  regionLabel: string,
  declaredReplica: Record<string, unknown> | undefined,
  served: boolean
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // ContributorInsights (table-level only in v1).
  try {
    const ci = await client.send(new DescribeContributorInsightsCommand({ TableName: tableName }));
    // go-to-k/cdkd#5381: `ENABLING` reads as enabled (the deploy that turned
    // insights on captures its baseline moments later), and a DECLARED
    // `Mode` is read back.
    const block = reverseMapReplicaContributorInsights(
      ci.ContributorInsightsStatus,
      ci.ContributorInsightsMode,
      declaredReplica?.['ContributorInsightsSpecification']
    );
    if (block !== undefined) out['ContributorInsightsSpecification'] = block;
  } catch (err) {
    // A replica region's not-found omits the member, strict or not: the replica
    // is being created or removed, which `unsettledInTransition` reports. Any
    // other failure throws (go-to-k/cdkd#6759; #5487 for `readUnsettled`).
    if ((served || strictFor('Replicas')) && !(err instanceof ResourceNotFoundException)) throw err;
    this.logger.debug(
      `Could not read ContributorInsights for ${tableName} in ${regionLabel}: ${describeAwsFailure(err).detail}`
    );
  }

  // PointInTimeRecovery via DescribeContinuousBackups.
  try {
    const pitr = await client.send(new DescribeContinuousBackupsCommand({ TableName: tableName }));
    const description = pitr.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
    // go-to-k/cdkd#5381: `RecoveryPeriodInDays` is read back, so a
    // `drift --revert` re-sends the recorded period instead of none (which
    // `UpdateContinuousBackups` reads as DynamoDB's default), and a
    // transient status reads as its target.
    const block = reverseMapReplicaPitr(
      description?.PointInTimeRecoveryStatus,
      description?.RecoveryPeriodInDays,
      declaredReplica?.['PointInTimeRecoverySpecification']
    );
    if (block !== undefined) out['PointInTimeRecoverySpecification'] = block;
  } catch (err) {
    // The same not-found tolerance; `DescribeContinuousBackups` spells its
    // not-found `TableNotFoundException`.
    if (
      (served || strictFor('Replicas')) &&
      !(err instanceof ResourceNotFoundException) &&
      !(err instanceof TableNotFoundException)
    ) {
      throw err;
    }
    this.logger.debug(
      `Could not read PointInTimeRecovery for ${tableName} in ${regionLabel}: ${describeAwsFailure(err).detail}`
    );
  }

  // Kinesis streaming destination — pick the first ACTIVE destination
  // (CFn's per-replica shape only carries one StreamArn).
  try {
    const ks = await client.send(
      new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
    );
    const destinations = ks.KinesisDataStreamDestinations ?? [];
    const active = destinations.find(
      (d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING'
    );
    if (active?.StreamArn) {
      const ksOut: Record<string, unknown> = { StreamArn: active.StreamArn };
      if (active.ApproximateCreationDateTimePrecision !== undefined) {
        ksOut['ApproximateCreationDateTimePrecision'] = active.ApproximateCreationDateTimePrecision;
      }
      out['KinesisStreamSpecification'] = ksOut;
    }
  } catch (err) {
    // The same not-found tolerance.
    if ((served || strictFor('Replicas')) && !(err instanceof ResourceNotFoundException)) throw err;
    this.logger.debug(
      `Could not read KinesisStreamingDestination for ${tableName} in ${regionLabel}: ${describeAwsFailure(err).detail}`
    );
  }

  return out;
}

/**
 * Read a replica's `ResourcePolicy` (on its table arn) and
 * `ReplicaStreamSpecification.ResourcePolicy` (on its stream arn) into
 * `entry` (go-to-k/cdkd#5381), in the CFn `{ PolicyDocument }` shape and the
 * declared spelling of the document.
 *
 * Each is GATED on the replica's DECLARED entry naming a usable policy — the
 * reader the write plan runs. That keeps an undeclared policy out of a
 * `Replicas` entry drift compares whole, and spends no call on a replica
 * that declares none, as the sibling `AWS::DynamoDB::Table` read does.
 *
 * `GetResourcePolicy` is eventually consistent, and the deploy captures its
 * baseline right after the put: on that capture (`afterOwnWrite`) an answer
 * that differs from the declaration is re-asked a few times before it is
 * believed. Any other read takes the first answer. `afterOwnWrite`: a policy
 * still ABSENT or still another document then, or a read that failed
 * transiently or after an unsettled answer, keeps the declared member rather
 * than freeze a value the settled replica never shows (a replaced document
 * recorded there would let `--revert` re-grant it, go-to-k/cdkd#6604).
 * Every other read believes its answer, so a policy removed out of band is
 * drift. Any other failed read throws (go-to-k/cdkd#6759) unless the replica
 * is not served (`served` false, see {@link readReplicaSubSpecs}). Policy text
 * is never logged.
 */
export async function readReplicaPolicies(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string,
  regionLabel: string,
  tableArn: string | undefined,
  streamArn: string | undefined,
  declaredReplica: Record<string, unknown> | undefined,
  afterOwnWrite: boolean,
  entry: Record<string, unknown>,
  served: boolean
): Promise<void> {
  if (declaredReplica === undefined) return;
  const readOne = async (
    what: string,
    arn: string | undefined,
    container: unknown
  ): Promise<Record<string, unknown> | undefined> => {
    if (arn === undefined || arn === '') return undefined;
    const declaredMember = (): Record<string, unknown> | undefined =>
      declaredPolicyMember(container);
    let last: string | undefined;
    const read = async (): Promise<string | undefined> => {
      try {
        const response = await client.send(new GetResourcePolicyCommand({ ResourceArn: arn }));
        last = response.Policy;
      } catch (err) {
        if (!(err instanceof PolicyNotFoundException)) throw err;
        last = undefined;
      }
      return last;
    };
    try {
      let live = await read();
      // Only the capture right after cdkd's own write can be lagging behind
      // it; a drift read takes the first answer, so a real out-of-band
      // change costs no re-reads.
      for (const delayMs of afterOwnWrite ? this.policyRereadDelaysMs : []) {
        if (policyMatchesDeclared(live, container)) break;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        live = await read();
      }
      // go-to-k/cdkd#6604: an answer still differing from the declaration is
      // the replaced policy the put overwrote; recording it would let
      // `--revert` re-grant it.
      if (afterOwnWrite && !policyMatchesDeclared(live, container)) {
        this.logger.debug(
          safeMsg`Kept the declared ${what} of the ${regionLabel} replica of ${tableName} in the baseline captured after its write: the read never settled on it`
        );
        return declaredMember();
      }
      return reverseMapPolicyMember(live, container);
    } catch (err) {
      // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
      // A replica region's not-found omits the member, strict or not: the replica
      // is being created or removed, which `unsettledInTransition` reports.
      if (strictFor('Replicas') && !(err instanceof ResourceNotFoundException)) throw err;
      this.logger.debug(
        safeMsg`Could not read the ${what} of the ${regionLabel} replica of ${tableName}: ${describeAwsFailure(err).detail}`
      );
      if (
        afterOwnWrite &&
        ((last !== undefined && last !== '') ||
          isThrottlingError(err) ||
          isTransientServerError(err) ||
          isAmbiguousOutcomeError(err) ||
          err instanceof ResourceNotFoundException)
      ) {
        return declaredMember();
      }
      // go-to-k/cdkd#6759: a not-found omits the member; any other failure on
      // a served replica rejects the read rather than leave it uncompared.
      if (served && !(err instanceof ResourceNotFoundException)) throw err;
      return undefined;
    }
  };
  if (readTablePolicy(declaredReplica).kind === 'usable') {
    const member = await readOne('ResourcePolicy', tableArn, declaredReplica);
    if (member !== undefined) entry['ResourcePolicy'] = member;
  }
  if (readStreamPolicy(declaredReplica).kind === 'usable') {
    const member = await readOne(
      'stream ResourcePolicy',
      streamArn,
      declaredReplica['ReplicaStreamSpecification']
    );
    if (member !== undefined) entry['ReplicaStreamSpecification'] = { ResourcePolicy: member };
  }
}

/**
 * Reverse-map application-autoscaling state for the given DynamoDB table
 * dimension into the CFn `*CapacityAutoScalingSettings` shape (Issue
 * #395). Used for BOTH the table-level write dimension
 * (`dynamodb:table:WriteCapacityUnits`) and the per-replica read
 * dimension (`dynamodb:table:ReadCapacityUnits`); the CFn shape is
 * symmetric.
 *
 * Returns shape (CFn-canonical PascalCase keys, verified via `cdk synth`
 * on a real `TableV2` with `Capacity.autoscaled(...)` on 2026-05-16 —
 * see PR notes for the probe transcript):
 *
 * ```
 * {
 *   MinCapacity: number;
 *   MaxCapacity: number;
 *   TargetTrackingScalingPolicyConfiguration: {
 *     TargetValue: number;
 *     DisableScaleIn?: boolean;
 *     ScaleInCooldown?: number;
 *     ScaleOutCooldown?: number;
 *   };
 * }
 * ```
 *
 * `SeedCapacity` is intentionally NOT round-tripped — it is a CFn
 * create-only field with no corresponding application-autoscaling
 * surface (AWS does not retain the initial seed value once the
 * scaling target is registered).
 *
 * Resolution order:
 *  1. `DescribeScalableTargets` → recover `MinCapacity` / `MaxCapacity`
 *     for the matching `ScalableDimension`. Returns `null` when no
 *     target is registered (= no autoscaling in play for this
 *     dimension — caller falls back to the flat capacity surface).
 *  2. `DescribeScalingPolicies` → find the `TargetTrackingScaling`
 *     policy (filter out `StepScaling` / `PredictiveScaling` — CFn's
 *     shape only carries the target-tracking variant). Returns `null`
 *     when no `TargetTrackingScaling` policy is present (a scaling
 *     target without a target-tracking policy is not cdkd-managed
 *     drift territory; surface the flat capacity instead).
 *
 * Application Auto Scaling answers an unregistered dimension with an EMPTY
 * list, never an error, so it has no not-found code: any failure (permissions
 * gap, throttle, network) throws (go-to-k/cdkd#6759) — it used to return
 * `null`, which read as "not autoscaled" and swapped in the flat capacity.
 * Only a replica AWS is not serving (`served` false) keeps that fallback.
 *
 * @param tableName DynamoDB table name (the `physicalId`).
 * @param scalableDimension Any of the four dimensions a GlobalTable can
 *   register — the two `dynamodb:table:*` ones and, since issue #1420's
 *   GSI reverse map, the two `dynamodb:index:*` ones.
 * @param client Pre-built region-scoped autoscaling client. Defaults to
 *   a fresh client in the local region — pass an explicit client when
 *   reading from a cross-region replica.
 * @param indexName Required for a `dynamodb:index:*` dimension; the
 *   `ResourceId` is built through the shared {@link autoScalingResourceId}
 *   so the read cannot spell it differently from the register / deregister
 *   calls.
 */
export async function readAutoScalingSettings(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  scalableDimension: DynamoDBScalableDimension,
  client?: ApplicationAutoScalingClient,
  indexName?: string,
  served = true
): Promise<Record<string, unknown> | null> {
  const resourceId = autoScalingResourceId(tableName, indexName);
  try {
    const asClient =
      client ??
      new ApplicationAutoScalingClient({
        ...ambientClientDefaults(),
        region: (await this.dynamoDBClient.config.region()) ?? '',
      });

    // 1. Probe ScalableTargets for Min/Max.
    const targetsResp = await asClient.send(
      new DescribeScalableTargetsCommand({
        ServiceNamespace: 'dynamodb',
        ResourceIds: [resourceId],
        ScalableDimension: scalableDimension,
      })
    );
    const targets = targetsResp.ScalableTargets ?? [];
    if (targets.length === 0) return null;
    const target = targets[0]!;
    if (target.MinCapacity === undefined || target.MaxCapacity === undefined) {
      return null;
    }

    // 2. Probe ScalingPolicies for the TargetTrackingScaling policy.
    const policiesResp = await asClient.send(
      new DescribeScalingPoliciesCommand({
        ServiceNamespace: 'dynamodb',
        ResourceId: resourceId,
        ScalableDimension: scalableDimension,
      })
    );
    const policies = policiesResp.ScalingPolicies ?? [];
    const targetTracking = policies.find((p) => p.PolicyType === 'TargetTrackingScaling');
    if (!targetTracking) return null;
    const cfg = targetTracking.TargetTrackingScalingPolicyConfiguration;
    if (!cfg || cfg.TargetValue === undefined) return null;

    const tttConfig: Record<string, unknown> = { TargetValue: cfg.TargetValue };
    if (cfg.DisableScaleIn !== undefined) {
      tttConfig['DisableScaleIn'] = cfg.DisableScaleIn;
    }
    if (cfg.ScaleInCooldown !== undefined) {
      tttConfig['ScaleInCooldown'] = cfg.ScaleInCooldown;
    }
    if (cfg.ScaleOutCooldown !== undefined) {
      tttConfig['ScaleOutCooldown'] = cfg.ScaleOutCooldown;
    }

    return {
      MinCapacity: target.MinCapacity,
      MaxCapacity: target.MaxCapacity,
      TargetTrackingScalingPolicyConfiguration: tttConfig,
    };
  } catch (err) {
    // go-to-k/cdkd#5487: an unsettled name is read strictly (`readUnsettled`).
    if (
      served ||
      strictFor(
        indexName !== undefined
          ? 'GlobalSecondaryIndexes'
          : scalableDimension.includes('Write')
            ? 'WriteProvisionedThroughputSettings'
            : 'Replicas'
      )
    )
      throw err;
    this.logger.debug(
      `Could not read application-autoscaling settings for ${resourceId} (${scalableDimension}): ${describeAwsFailure(err).detail}`
    );
    return null;
  }
}

/**
 * Adopt an existing DynamoDB GlobalTable into cdkd state.
 *
 * Lookup order:
 *   1. `--resource` override or `Properties.TableName` → verify via DescribeTable.
 *
 * Same shape as `DynamoDBTableProvider.import()`. The provider returns
 * the physical id only; cdkd's import flow does the attribute capture
 * separately.
 */
export async function importResource(
  this: DynamoDBGlobalTableProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'TableName');
  if (explicit) {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: explicit })
      );
      // Issue #3627: the same map `create()` records. The resolver's
      // `StreamArn` arm refuses the reference without it (issue #4077).
      return {
        physicalId: explicit,
        attributes: definedAttributes({
          Arn: resp.Table?.TableArn,
          TableId: resp.Table?.TableId,
          StreamArn: resp.Table?.LatestStreamArn,
          TableName: resp.Table?.TableName ?? explicit,
        }),
      };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a table
  // reaching here needs an explicit `--resource` override.
  return null;
}

/**
 * What the update's tag calls wrote to a replica, for the post-write capture
 * to settle on (go-to-k/cdkd#6609): only on that capture (`afterOwnWrite`),
 * only when the update tagged or untagged this replica (`recordTagWrite`,
 * consumed here), and only for a replica the template declares. `undefined`:
 * take the first answer.
 */
export function writtenReplicaTags(
  afterOwnWrite: boolean,
  replicaArn: string,
  declaredReplica: Record<string, unknown> | undefined
): TagWrite | undefined {
  if (!afterOwnWrite) return undefined;
  const written = takeTagWrite('AWS::DynamoDB::GlobalTable', replicaArn);
  return declaredReplica === undefined ? undefined : written;
}

/**
 * A replica's `Tags` on the post-write capture: `listTags` re-asked until it
 * shows `written`, else the newest answer with it overlaid
 * (`settleWrittenTags`). A deterministic first failure (a not-found too)
 * throws to the caller's existing handling.
 */
export function settleReplicaTags(
  this: DynamoDBGlobalTableProvider,
  listTags: () => Promise<ReadTag[]>,
  written: TagWrite,
  logicalId: string
): Promise<ReadTag[]> {
  return settleWrittenTags(listTags, listTags, written, this.tagsBaselineRereadDelaysMs, () =>
    warnUnsettledMember(this.logger, logicalId, 'AWS::DynamoDB::GlobalTable', 'Tags')
  );
}
