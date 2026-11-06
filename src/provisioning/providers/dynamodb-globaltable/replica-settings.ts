import {
  DynamoDBClient,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeTableCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PolicyNotFoundException,
  UpdateTableCommand,
  type GlobalTableSettingsReplicationMode,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { configBooleanRefusal } from '../../config-shape.js';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import { waitForIndexesSettled, maskedLogger } from '../../dynamodb-index-busy-delete.js';
import type { SecretMasker } from '../../../types/resource.js';
import { indexEntriesByName } from '../../dynamodb-contributor-insights.js';
import {
  declaredIndexInsights,
  declaredReplicaSettings,
  planReplicaIndexInsightsOps,
  readPitrSpec,
  readStreamPolicy,
  samePolicyDocument,
  planReplicaSettingCorrections,
  planReplicaSettingOps,
  settingOf,
  SETTING_MEMBER,
  type LiveReplicaSettings,
  type ReplicaSetting,
} from '../../dynamodb-replica-settings.js';
import { markUnsettled } from './projection.js';
import {
  localReplicaEntry,
  readReplicaKmsMasterKeyId,
  isKmsKeyArn,
  toSdkTableSseSpecification,
} from './replica-shape.js';
import { asRecord } from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * `update()`'s customer managed key pass for a table with cross-region
 * replicas (go-to-k/cdkd#5355). DynamoDB takes such a key change only
 * through `ReplicaUpdates`, and only with EVERY region's key in the same
 * call — the table's own region as one of the entries (measured 2026-10-26:
 * `SSESpecification` with a key is refused, a one-replica `Update` is
 * refused with "KMSMasterKeyId must be specified for each replica", and an
 * `Update` per region in one call is accepted, from the AWS owned key, the
 * AWS managed key or another customer managed key alike).
 *
 * Sent when a region's declared key changed in the template, or when a
 * declared key ARN differs from the one AWS reports (a table deployed
 * before this issue sits on the AWS managed key under a record naming the
 * declared one; AWS reports every key as an ARN — measured). A region
 * without a declared key keeps the key AWS reports. A template-side change
 * that fails, or that leaves a region with neither key (DynamoDB needs
 * every region's), fails the update; a correction AWS alone asked for is
 * best-effort and reported, as {@link convergeReplicaSettings} is.
 * A table without cross-region replicas took its key through
 * `SSESpecification` already.
 */
export async function applyReplicaKeys(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  currentRegion: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  addedRegions: ReadonlySet<unknown>,
  // The local key update step 3 held back for this pass, if any.
  deferredSseUpdate: UpdateTableCommandInput['SSESpecification'],
  // Whether that held-back update is a template change (else an AWS-aware
  // correction, best-effort like the rest of the convergence).
  deferredSseFromTemplate: boolean,
  // Whether step 3 sent a template-driven `SSESpecification` without a key,
  // which moved every replica to the AWS managed key.
  keylessSseFromTemplate: boolean,
  maskSecrets: SecretMasker
): Promise<void> {
  const tableOnKms =
    properties['SSESpecification'] !== undefined &&
    configBooleanRefusal(
      properties['SSESpecification'],
      'SSEEnabled',
      'AWS::DynamoDB::GlobalTable SSESpecification'
    ) === undefined &&
    toSdkTableSseSpecification(properties['SSESpecification'], undefined).Enabled;
  if (!tableOnKms) return;
  const declared = new Map<string, string | undefined>();
  for (const entry of Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : []) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region === 'string') declared.set(region, readReplicaKmsMasterKeyId(replica));
  }
  if ([...declared.values()].every((key) => key === undefined)) return;
  // A cross-region replica's key changed in the template: not one this
  // update added (its `Create` carried the key) and not one the template
  // stopped naming. The local key's change is step 3's held-back update.
  const replicaKeyChanged = [...declared].some(
    ([region, key]) =>
      region !== currentRegion &&
      key !== undefined &&
      !addedRegions.has(region) &&
      key !== readReplicaKmsMasterKeyId(localReplicaEntry(previousProperties, region))
  );
  let liveKeys: Map<string, string | undefined>;
  try {
    liveKeys = await this.readLiveKeys(tableName, currentRegion);
  } catch (readError) {
    if (replicaKeyChanged || deferredSseFromTemplate || keylessSseFromTemplate) throw readError;
    this.logger.debug(
      maskSecrets(
        `Could not read the KMS keys of ${tableName} to converge them: ` +
          describeAwsFailure(readError).detail
      )
    );
    return;
  }
  // A held-back local update whose key AWS already reports (only the
  // block's spelling changed) is no change.
  const templateChanged =
    replicaKeyChanged ||
    (keylessSseFromTemplate &&
      [...declared].some(([region, key]) => region !== currentRegion && key !== undefined)) ||
    (deferredSseFromTemplate && declared.get(currentRegion) !== liveKeys.get(currentRegion));
  let request: UpdateTableCommandInput;
  if (liveKeys.size < 2) {
    // The update dropped every cross-region replica: the key held back for
    // this pass goes through `SSESpecification` after all.
    if (deferredSseUpdate === undefined) return;
    request = { TableName: tableName, SSESpecification: deferredSseUpdate };
  } else {
    const built = this.replicaKeysRequest(
      tableName,
      logicalId,
      liveKeys,
      declared,
      templateChanged,
      maskSecrets
    );
    if (built === undefined) return;
    request = built;
  }
  try {
    markUnsettled('SSESpecification', 'Replicas');
    await this.dynamoDBClient.send(new UpdateTableCommand(request));
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
  } catch (keyError) {
    if (templateChanged || isInterruptedWaitError(keyError)) throw keyError;
    this.logger.debug(
      maskSecrets(
        `Could not bring the KMS keys of ${tableName} to the declared ones: ` +
          describeAwsFailure(keyError).detail
      )
    );
    this.logger.warn(
      maskSecrets(
        `${tableName} does not hold its declared KMS keys, and setting them failed ` +
          `(${describeAwsFailure(keyError).summary}). The next deploy that updates this ` +
          `table tries again.`
      )
    );
  }
}

/** The key ARN each region of `tableName` reports, the local one included. */
export async function readLiveKeys(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  currentRegion: string
): Promise<Map<string, string | undefined>> {
  const described = await this.dynamoDBClient.send(
    new DescribeTableCommand({ TableName: tableName })
  );
  const keys = new Map<string, string | undefined>([
    [currentRegion, described.Table?.SSEDescription?.KMSMasterKeyArn],
  ]);
  for (const r of described.Table?.Replicas ?? []) {
    if (r.RegionName !== undefined && r.RegionName !== currentRegion) {
      keys.set(r.RegionName, r.KMSMasterKeyId);
    }
  }
  return keys;
}

/**
 * {@link applyReplicaKeys}' `ReplicaUpdates` call for a table with
 * cross-region replicas, or `undefined` when there is nothing to send.
 */
export function replicaKeysRequest(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  liveKeys: ReadonlyMap<string, string | undefined>,
  declared: ReadonlyMap<string, string | undefined>,
  templateChanged: boolean,
  maskSecrets: SecretMasker
): UpdateTableCommandInput | undefined {
  const drifted = [...liveKeys].some(([region, live]) => {
    const key = declared.get(region);
    return isKmsKeyArn(key) && key !== live;
  });
  if (!templateChanged && !drifted) {
    this.logger.debug(
      maskSecrets(`Every region of ${tableName} already holds its declared KMS key`)
    );
    return undefined;
  }
  const entries = [...liveKeys].map(([region, live]) => ({
    Update: { RegionName: region, KMSMasterKeyId: declared.get(region) ?? live },
  }));
  const keyless = entries.filter((e) => e.Update.KMSMasterKeyId === undefined);
  if (keyless.length > 0) {
    const text =
      `The KMS keys of ${tableName} were not changed: DynamoDB takes every region's key ` +
      `in one call, and no key is declared or reported for ` +
      `${keyless.map((e) => e.Update.RegionName).join(', ')}`;
    // A change the template asked for fails the update; a correction AWS
    // alone asked for is reported.
    if (templateChanged) {
      throw new ProvisioningError(
        maskSecrets(`${text}. Declare a key for every replica`),
        'AWS::DynamoDB::GlobalTable',
        logicalId,
        tableName
      );
    }
    this.logger.warn(maskSecrets(`${text}.`));
    return undefined;
  }
  this.logger.debug(
    maskSecrets(`Setting the KMS key of every region of ${tableName} in one ReplicaUpdates call`)
  );
  return { TableName: tableName, ReplicaUpdates: entries };
}

/**
 * The per-replica settings pass (go-to-k/cdkd#5365): point-in-time recovery,
 * Contributor Insights, the Kinesis streaming destination and the two
 * resource policies — none of which rides `CreateTable` or `ReplicaUpdates` —
 * for every replica the desired side declares, the local table included,
 * each through its own region.
 *
 * `previousProperties` is `undefined` on `create()`; `freshRegions` names
 * the replicas this operation created, which hold none of the settings yet.
 * A template-side change that fails fails the operation. On `update()` a
 * DECLARED setting the template did not change is also checked against AWS
 * and corrected — before this issue none was ever sent, so a replica deployed
 * then holds none of them under a record that names them — and that
 * correction is best-effort and reported, like {@link convergeReplicaSettings}.
 */
export async function applyReplicaSettings(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  currentRegion: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  freshRegions: ReadonlySet<unknown>,
  streamReplaced: boolean,
  // A state replay (no template to fix): a table policy refused on a replica
  // this operation created is reported rather than failing the replay.
  replaying: boolean,
  // Settings whose removal arm is skipped (see `planReplicaSettingOps`).
  keepOnRemoval: ReadonlySet<ReplicaSetting>,
  // The deploy region's stream arn BEFORE this operation, for a
  // `StreamViewType` change: the old stream stays readable for 24 h, so a
  // policy the template removed is deleted from it too.
  previousLocalStreamArn: string | undefined,
  warn: (message: string) => void,
  maskSecrets: SecretMasker
): Promise<void> {
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  // go-to-k/cdkd#5489: a replica's per-index Contributor Insights. On a
  // create every index already exists, so it is sent here; `update()` runs
  // this pass BEFORE its GSI diff, so a new index does not exist yet, and
  // {@link applyReplicaIndexInsights} sends them all after that diff.
  const tableIndexNames =
    previousProperties === undefined
      ? new Set(indexEntriesByName(properties['GlobalSecondaryIndexes']).keys())
      : undefined;
  for (const entry of desired) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region !== 'string' || region === '') continue;
    const fresh = previousProperties === undefined || freshRegions.has(region);
    const previous =
      previousProperties === undefined ? undefined : localReplicaEntry(previousProperties, region);
    const ops = planReplicaSettingOps(
      replica,
      previous,
      {
        fresh,
        streamReplaced,
        keepOnRemoval,
        ...(tableIndexNames !== undefined && { tableIndexNames }),
      },
      (reason) =>
        warn(
          `The ${region} replica of ${tableName}: ${reason}, so that setting was left as it ` +
            `is. ` +
            (replaying
              ? `The value came from a recorded state, which a template edit cannot reach.`
              : `Fix the template value and re-deploy.`)
        )
    );
    if (
      !fresh &&
      keepOnRemoval.has('pitr') &&
      replica?.['PointInTimeRecoverySpecification'] == null &&
      (() => {
        const prior = readPitrSpec(previous?.['PointInTimeRecoverySpecification']);
        return prior.kind === 'usable' && prior.enabled;
      })()
    ) {
      warn(
        `The ${region} replica of ${tableName}: point-in-time recovery was not turned off, ` +
          `although the properties being applied (a rollback's recorded state, or a drift ` +
          `--revert read-back) declare none — turning it off would delete every recovery ` +
          `point. Turn it off by hand if that is intended.`
      );
    }
    // What the template did not change but declares: checked against AWS.
    const unchanged = fresh ? new Set<ReplicaSetting>() : declaredReplicaSettings(replica);
    // Checked by `applyReplicaIndexInsights`, after `update()`'s GSI diff.
    unchanged.delete('indexContributorInsights');
    for (const op of ops) unchanged.delete(settingOf(op));
    if (ops.length === 0 && unchanged.size === 0) continue;

    const client = region === currentRegion ? this.dynamoDBClient : this.getRegionalClient(region);
    // A key, class or protection change moments earlier leaves the table
    // (and this replica) UPDATING, and these calls are refused meanwhile.
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, {
      ...(region !== currentRegion && { region }),
    });
    let arns: { tableArn?: string; streamArn?: string } | undefined;
    const describe = async (): Promise<{ tableArn?: string; streamArn?: string }> => {
      if (arns === undefined) {
        const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
        arns = {
          ...(described.Table?.TableArn !== undefined && { tableArn: described.Table.TableArn }),
          ...(described.Table?.LatestStreamArn !== undefined && {
            streamArn: described.Table.LatestStreamArn,
          }),
        };
      }
      return arns;
    };

    for (const op of ops) {
      try {
        await this.sendReplicaSettingOp(
          client,
          tableName,
          region,
          logicalId,
          op,
          describe,
          maskSecrets
        );
      } catch (error) {
        // A table policy on a replica this operation created is refused on
        // the template path (`replicaSettingsRefusal`, CloudFormation
        // parity), so only a state replay reaches here: it is reported, and
        // the next update's AWS-aware pass puts it.
        if (!replaying || !fresh || op.kind !== 'putTablePolicy' || isInterruptedWaitError(error)) {
          throw error;
        }
        warn(
          `The ${region} replica of ${tableName} was created without its ResourcePolicy: ` +
            `${describeAwsFailure(error).summary}. The next deploy that updates this table ` +
            `puts it.`
        );
      }
    }

    // A `StreamViewType` change leaves the OLD stream readable for 24 h
    // under its old policy. When this deploy removes or changes that policy
    // in the template, the old stream loses it too — best-effort: it may
    // already be gone. An UNCHANGED policy stays there, so a consumer still
    // draining the old stream keeps its access. Only the deploy region's
    // retired stream is known here: a cross-region replica's keeps its old
    // policy until it expires.
    const priorStreamPolicy = readStreamPolicy(previous);
    const desiredStreamPolicy = readStreamPolicy(replica);
    const streamPolicyChanged =
      priorStreamPolicy.kind !== 'absent' &&
      desiredStreamPolicy.kind !== 'unusable' &&
      !(desiredStreamPolicy.kind === 'absent' && keepOnRemoval.has('streamPolicy')) &&
      !(
        priorStreamPolicy.kind === 'usable' &&
        desiredStreamPolicy.kind === 'usable' &&
        samePolicyDocument(priorStreamPolicy.document, desiredStreamPolicy.document)
      );
    if (
      region === currentRegion &&
      streamReplaced &&
      previousLocalStreamArn !== undefined &&
      streamPolicyChanged &&
      (await describe()).streamArn !== previousLocalStreamArn
    ) {
      await this.deleteOldStreamPolicy(
        client,
        previousLocalStreamArn,
        tableName,
        warn,
        maskSecrets
      );
    }

    if (unchanged.size === 0) continue;
    const live = await this.readLiveReplicaSettings(
      client,
      tableName,
      region,
      unchanged,
      describe,
      maskSecrets,
      replica
    );
    for (const op of planReplicaSettingCorrections(replica, live, unchanged)) {
      const member = SETTING_MEMBER[settingOf(op)];
      this.logger.debug(
        maskSecrets(`Bringing the ${region} replica of ${tableName} to its declared ${member}`)
      );
      try {
        await this.sendReplicaSettingOp(
          client,
          tableName,
          region,
          logicalId,
          op,
          describe,
          maskSecrets
        );
      } catch (convergeError) {
        if (isInterruptedWaitError(convergeError)) throw convergeError;
        this.logger.debug(
          maskSecrets(
            `Could not bring the ${region} replica of ${tableName} to its declared ${member}: ` +
              describeAwsFailure(convergeError).detail
          )
        );
        this.logger.warn(
          maskSecrets(
            `The ${region} replica of ${tableName} does not hold its declared ${member}, and ` +
              `setting it failed (${describeAwsFailure(convergeError).summary}). The next ` +
              `deploy that updates this table tries again.`
          )
        );
      }
    }
  }
}

/**
 * Send a `GlobalTableSettingsReplicationMode` change (go-to-k/cdkd#5489) in
 * its own `UpdateTable`, as CloudFormation does, and wait for the table to
 * settle. A failure fails the update: the template asked for it.
 */
export async function sendReplicationMode(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  mode: string,
  maskSecrets: SecretMasker,
  // `false` for a correction AWS alone asked for: a failure is reported.
  fromTemplate = true
): Promise<void> {
  this.logger.debug(
    maskSecrets(`Setting GlobalTableSettingsReplicationMode of ${tableName} to ${mode}`)
  );
  await this.sendLocalSettingUpdate(
    {
      TableName: tableName,
      GlobalTableSettingsReplicationMode: mode as GlobalTableSettingsReplicationMode,
    },
    fromTemplate,
    'GlobalTableSettingsReplicationMode',
    tableName,
    logicalId,
    maskSecrets
  );
}

/**
 * `update()`'s per-index Contributor Insights pass over every replica
 * (go-to-k/cdkd#5489), run AFTER the GSI diff so an index this update
 * created exists. The template-driven calls fail the update; a declared
 * setting the template did not change is checked against AWS and corrected
 * best-effort — before this issue none was ever sent, so a replica deployed
 * then holds none of them under a record that names them.
 */
export async function applyReplicaIndexInsights(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  currentRegion: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  freshRegions: ReadonlySet<unknown>,
  keepOnRemoval: ReadonlySet<ReplicaSetting>,
  replaying: boolean,
  warn: (message: string) => void,
  maskSecrets: SecretMasker
): Promise<void> {
  const tableIndexNames = new Set(indexEntriesByName(properties['GlobalSecondaryIndexes']).keys());
  if (tableIndexNames.size === 0) return;
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  for (const entry of desired) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region !== 'string' || region === '') continue;
    const fresh = freshRegions.has(region);
    const ops = planReplicaIndexInsightsOps(
      replica,
      localReplicaEntry(previousProperties, region),
      {
        fresh,
        tableIndexNames,
        removes: (setting) => !keepOnRemoval.has(setting),
      },
      (reason) =>
        warn(
          `The ${region} replica of ${tableName}: ${reason}, so that setting was left as it ` +
            `is. ` +
            (replaying
              ? `The value came from a recorded state, which a template edit cannot reach.`
              : `Fix the template value and re-deploy.`)
        )
    );
    // Declared, unchanged and on the table: checked against AWS.
    const addressed = new Set(
      ops.flatMap((op) => (op.kind === 'indexContributorInsights' ? [op.indexName] : []))
    );
    const declared = declaredIndexInsights(replica);
    const unchanged = fresh
      ? []
      : [...declared.keys()].filter((name) => tableIndexNames.has(name) && !addressed.has(name));
    if (ops.length === 0 && unchanged.length === 0) continue;

    const client = region === currentRegion ? this.dynamoDBClient : this.getRegionalClient(region);
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, {
      ...(region !== currentRegion && { region }),
    });
    // An index this update created may still be building in this region,
    // and its rules cannot be set until it is ACTIVE. Best-effort: a wait
    // that ends unconfirmed leaves AWS's own refusal as the backstop.
    await waitForIndexesSettled({
      tableName,
      logicalId,
      logger: maskedLogger(this.logger, maskSecrets, tableName),
      describeTable: () => client.send(new DescribeTableCommand({ TableName: tableName })),
      maxAttempts: 900,
      proceedNote: `setting the index's Contributor Insights may be refused.`,
    });
    // No op here addresses an arn.
    const describe = (): Promise<{ tableArn?: string; streamArn?: string }> => Promise.resolve({});
    for (const op of ops) {
      await this.sendReplicaSettingOp(
        client,
        tableName,
        region,
        logicalId,
        op,
        describe,
        maskSecrets
      );
    }
    if (unchanged.length === 0) continue;
    const replicaIndexes = indexEntriesByName(replica?.['GlobalSecondaryIndexes']);
    const onlyUnchanged: Record<string, unknown> = {
      ...replica,
      GlobalSecondaryIndexes: unchanged.map((name) => replicaIndexes.get(name)),
    };
    const only = new Set<ReplicaSetting>(['indexContributorInsights']);
    const live = await this.readLiveReplicaSettings(
      client,
      tableName,
      region,
      only,
      describe,
      maskSecrets,
      onlyUnchanged
    );
    for (const op of planReplicaSettingCorrections(onlyUnchanged, live, only)) {
      try {
        await this.sendReplicaSettingOp(
          client,
          tableName,
          region,
          logicalId,
          op,
          describe,
          maskSecrets
        );
      } catch (convergeError) {
        if (isInterruptedWaitError(convergeError)) throw convergeError;
        this.logger.warn(
          maskSecrets(
            `The ${region} replica of ${tableName} does not hold the declared ` +
              `${SETTING_MEMBER.indexContributorInsights} of an index, and setting it failed ` +
              `(${describeAwsFailure(convergeError).summary}). The next deploy that updates ` +
              `this table tries again.`
          )
        );
      }
    }
  }
}

/**
 * What AWS reports for the given settings of one replica. Each read is
 * best-effort: a failure leaves that setting unknown, and an unknown setting
 * is never corrected.
 */
export async function readLiveReplicaSettings(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string,
  region: string,
  wanted: ReadonlySet<ReplicaSetting>,
  describe: () => Promise<{ tableArn?: string; streamArn?: string }>,
  maskSecrets: SecretMasker,
  // The desired replica entry: names the indexes whose read is wanted.
  declared?: Record<string, unknown>
): Promise<LiveReplicaSettings> {
  const live: LiveReplicaSettings = {};
  const attempt = async (what: string, read: () => Promise<void>): Promise<void> => {
    try {
      await read();
    } catch (readError) {
      this.logger.debug(
        maskSecrets(
          `Could not read ${what} of the ${region} replica of ${tableName}: ` +
            describeAwsFailure(readError).detail
        )
      );
    }
  };
  if (wanted.has('pitr')) {
    await attempt('point-in-time recovery', async () => {
      const out = await client.send(new DescribeContinuousBackupsCommand({ TableName: tableName }));
      const pitr = out.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
      const status = pitr?.PointInTimeRecoveryStatus;
      // ENABLING / DISABLING are on their way: nothing to correct yet.
      if (status === 'ENABLED' || status === 'DISABLED') {
        live.pitr = {
          enabled: status === 'ENABLED',
          ...(pitr?.RecoveryPeriodInDays !== undefined && {
            recoveryPeriodInDays: pitr.RecoveryPeriodInDays,
          }),
        };
      }
    });
  }
  if (wanted.has('contributorInsights')) {
    await attempt('Contributor Insights', async () => {
      const out = await client.send(
        new DescribeContributorInsightsCommand({ TableName: tableName })
      );
      const status = out.ContributorInsightsStatus;
      if (status === 'ENABLED' || status === 'ENABLING') live.contributorInsightsEnabled = true;
      else if (status === 'DISABLED' || status === 'DISABLING') {
        live.contributorInsightsEnabled = false;
      }
    });
  }
  if (wanted.has('kinesis')) {
    await attempt('the Kinesis streaming destination', async () => {
      live.kinesisStreamArns = await this.activeKinesisStreamArns(client, tableName);
    });
  }
  const hasPolicy = async (arn: string | undefined): Promise<boolean | undefined> => {
    if (arn === undefined) return undefined;
    try {
      await client.send(new GetResourcePolicyCommand({ ResourceArn: arn }));
      return true;
    } catch (error) {
      if (error instanceof PolicyNotFoundException) return false;
      throw error;
    }
  };
  if (wanted.has('tablePolicy')) {
    await attempt('the resource policy', async () => {
      const answer = await hasPolicy((await describe()).tableArn);
      if (answer !== undefined) live.hasTablePolicy = answer;
    });
  }
  if (wanted.has('streamPolicy')) {
    await attempt('the stream resource policy', async () => {
      const answer = await hasPolicy((await describe()).streamArn);
      if (answer !== undefined) live.hasStreamPolicy = answer;
    });
  }
  if (wanted.has('indexContributorInsights')) {
    const perIndex = new Map<string, boolean>();
    for (const indexName of declaredIndexInsights(declared).keys()) {
      await attempt(`Contributor Insights of an index`, async () => {
        const out = await client.send(
          new DescribeContributorInsightsCommand({ TableName: tableName, IndexName: indexName })
        );
        const status = out.ContributorInsightsStatus;
        // ENABLING / DISABLING are on their way: nothing to correct yet.
        if (status === 'ENABLED' || status === 'DISABLED') {
          perIndex.set(indexName, status === 'ENABLED');
        }
      });
    }
    live.indexContributorInsightsEnabled = perIndex;
  }
  if (wanted.has('streamTags')) {
    await attempt('the stream tags', async () => {
      const arn = (await describe()).streamArn;
      if (arn === undefined) return;
      const tags = new Map<string, string>();
      let nextToken: string | undefined;
      do {
        const out = await client.send(
          new ListTagsOfResourceCommand({ ResourceArn: arn, NextToken: nextToken })
        );
        for (const t of out.Tags ?? []) {
          if (t.Key !== undefined) tags.set(t.Key, t.Value ?? '');
        }
        nextToken = out.NextToken;
      } while (nextToken !== undefined);
      live.streamTags = tags;
    });
  }
  return live;
}
