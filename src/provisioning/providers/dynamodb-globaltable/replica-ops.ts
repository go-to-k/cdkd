import {
  DynamoDBClient,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DeleteResourcePolicyCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  PolicyNotFoundException,
  PutResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateContributorInsightsCommand,
  UpdateKinesisStreamingDestinationCommand,
  UpdateTableCommand,
  ResourceNotFoundException,
  type ApproximateCreationDateTimePrecision,
  type ContributorInsightsMode,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { beginDeleteWait } from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { SecretMasker } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  settingOf,
  SETTING_MEMBER,
  type ReplicaSettingOp,
} from '../../dynamodb-replica-settings.js';
import { markUnsettled } from './projection.js';
import {
  GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
  REPLICA_COPY_RELEASE_POLLS,
  REPLICA_COPY_RELEASE_POLL_MS,
  DELETION_PROTECTION_REFLIP_MS,
  relayedEncryptionChangeLimit,
  KINESIS_DISABLE_UNSETTLED,
  REPLICA_PROTECTION_SETTLE_POLLS,
  SETTLING_RETRY_ATTEMPTS,
  SETTLING_RETRY_INITIAL_MS,
} from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * Delete the resource policy of a stream a `StreamViewType` change retired.
 * No policy, or no stream any more, is the goal; anything else is reported,
 * since the deploy itself succeeded and the old stream expires in 24 h.
 */
export async function deleteOldStreamPolicy(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  streamArn: string,
  tableName: string,
  warn: (message: string) => void,
  maskSecrets: SecretMasker
): Promise<void> {
  try {
    markUnsettled('Replicas');
    await this.retrySettlingRefusal(
      () => client.send(new DeleteResourcePolicyCommand({ ResourceArn: streamArn })),
      `delete the policy of the retired stream of ${tableName}`,
      maskSecrets
    );
  } catch (error) {
    if (isInterruptedWaitError(error)) throw error;
    if (error instanceof PolicyNotFoundException || error instanceof ResourceNotFoundException) {
      return;
    }
    warn(
      `The previous stream of ${tableName} (retired by the StreamViewType change) keeps its ` +
        `old resource policy until it expires: deleting it failed ` +
        `(${describeAwsFailure(error).summary}).`
    );
  }
}

/**
 * After a refused Kinesis enable / disable: whether the table streams to
 * `streamArn` now. An interrupt, or a read that fails, rethrows the ORIGINAL
 * refusal rather than hiding it behind the read's own error.
 */
export async function kinesisStreaming(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string,
  streamArn: string,
  refusal: unknown
): Promise<boolean> {
  if (isInterruptedWaitError(refusal)) throw refusal;
  try {
    return (await this.activeKinesisStreamArns(client, tableName)).has(streamArn);
  } catch {
    throw refusal;
  }
}

/**
 * Wait until no entry for `streamArn` among `tableName`'s destinations is
 * `ACTIVE`, `ENABLING`, `UPDATING` or `DISABLING` (the read-back's present
 * set, plus `DISABLING`, which is still settling: a later read can flicker
 * back to `ACTIVE`, above). Best-effort, since the disable itself was accepted: a
 * failed read ends the wait with a debug line, and running out of re-reads
 * or of the resource deadline ends it with a warning.
 */
export async function waitForKinesisDisableSettled(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string,
  streamArn: string,
  scope: string,
  maskSecrets: SecretMasker
): Promise<void> {
  const watch = startInterruptWatch(maskSecrets(`Kinesis streaming disable on ${scope}`));
  let last = 'none read';
  try {
    for (const delayMs of [0, ...this.kinesisDisableSettleDelaysMs]) {
      // The engine's deadline does not cancel this update: a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) break;
      if (delayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Math.min(delayMs, enclosingDeadlineRemainingMs())))
        );
      }
      if (watch.isInterrupted()) throw watch.onInterrupted();
      let unsettled: string | undefined;
      try {
        const out = await client.send(
          new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
        );
        // Judged across EVERY entry for the stream: history entries (a
        // DISABLED or ENABLE_FAILED one) linger beside the current entry,
        // and neither may decide the wait on its own.
        unsettled = (out.KinesisDataStreamDestinations ?? []).find(
          (d) =>
            d.StreamArn === streamArn && KINESIS_DISABLE_UNSETTLED.has(d.DestinationStatus ?? '')
        )?.DestinationStatus;
      } catch (error) {
        this.logger.debug(
          maskSecrets(
            `Could not confirm the Kinesis streaming disable on ${scope}: ` +
              describeAwsFailure(error).detail
          )
        );
        return;
      }
      if (unsettled === undefined) return;
      last = unsettled;
    }
    this.logger.warn(
      maskSecrets(
        `The Kinesis streaming destination on ${scope} had not settled ` +
          `(last status: ${last}); 'cdkd drift' may report it on this replica until it does`
      )
    );
  } finally {
    watch.dispose();
  }
}

/** The Kinesis streams a table streams to (`ACTIVE` or `ENABLING`). */
export async function activeKinesisStreamArns(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string
): Promise<Set<string>> {
  const out = await client.send(
    new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
  );
  return new Set(
    (out.KinesisDataStreamDestinations ?? [])
      .filter((d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING')
      .flatMap((d) => (d.StreamArn !== undefined ? [d.StreamArn] : []))
  );
}

/**
 * Send ONE {@link ReplicaSettingOp} through the replica's own region,
 * retrying the "settling" refusals DynamoDB returns while an earlier change
 * on the table is still in flight (enabling point-in-time recovery, say).
 * The policy text is never logged: it names principals and can carry a
 * resolved secret in a condition value.
 */
export async function sendReplicaSettingOp(
  this: DynamoDBGlobalTableProvider,
  client: DynamoDBClient,
  tableName: string,
  region: string,
  logicalId: string,
  op: ReplicaSettingOp,
  describe: () => Promise<{ tableArn?: string; streamArn?: string }>,
  maskSecrets: SecretMasker
): Promise<void> {
  const scope = `the ${region} replica of ${tableName}`;
  const arnFor = async (which: 'tableArn' | 'streamArn'): Promise<string> => {
    const arn = (await describe())[which];
    if (arn === undefined || arn === '') {
      throw new ProvisioningError(
        maskSecrets(
          `Cannot apply ${SETTING_MEMBER[settingOf(op)]} to ${scope}: DescribeTable returned ` +
            `no ${which === 'tableArn' ? 'TableArn' : 'LatestStreamArn (the table has no stream)'}`
        ),
        'AWS::DynamoDB::GlobalTable',
        logicalId,
        tableName
      );
    }
    return arn;
  };
  const send = (call: () => Promise<unknown>): Promise<void> => {
    // go-to-k/cdkd#5487: every op here changes a replica member.
    markUnsettled('Replicas');
    return this.retrySettlingRefusal(call, `${op.kind} on ${scope}`, maskSecrets);
  };
  switch (op.kind) {
    case 'pitr':
      await send(() =>
        client.send(
          new UpdateContinuousBackupsCommand({
            TableName: tableName,
            PointInTimeRecoverySpecification: {
              PointInTimeRecoveryEnabled: op.enabled,
              ...(op.recoveryPeriodInDays !== undefined && {
                RecoveryPeriodInDays: op.recoveryPeriodInDays,
              }),
            },
          })
        )
      );
      break;
    case 'contributorInsights':
      await send(() =>
        client.send(
          new UpdateContributorInsightsCommand({
            TableName: tableName,
            ContributorInsightsAction: op.action,
            ...(op.mode !== undefined && {
              ContributorInsightsMode: op.mode as ContributorInsightsMode,
            }),
          })
        )
      );
      break;
    case 'kinesisEnable':
      // Already streaming there (a re-run): enabling it again is refused, and
      // that refusal can be one the settling retry would wait out first.
      // A read that fails here falls through to the enable, which decides.
      if (
        await this.activeKinesisStreamArns(client, tableName).then(
          (arns) => arns.has(op.streamArn),
          () => false
        )
      ) {
        break;
      }
      try {
        await send(() =>
          client.send(
            new EnableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: op.streamArn,
              ...(op.precision !== undefined && {
                EnableKinesisStreamingConfiguration: {
                  ApproximateCreationDateTimePrecision:
                    op.precision as ApproximateCreationDateTimePrecision,
                },
              }),
            })
          )
        );
      } catch (error) {
        // A re-run after a deploy that enabled it and failed before state
        // recorded it: the destination is what the template asks for.
        if (!(await this.kinesisStreaming(client, tableName, op.streamArn, error))) throw error;
      }
      break;
    case 'kinesisDisable':
      try {
        await send(() =>
          client.send(
            new DisableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: op.streamArn,
            })
          )
        );
      } catch (error) {
        // Already off (a re-run, or an out-of-band disable) is the goal.
        if (await this.kinesisStreaming(client, tableName, op.streamArn, error)) throw error;
      }
      await this.waitForKinesisDisableSettled(client, tableName, op.streamArn, scope, maskSecrets);
      break;
    case 'kinesisPrecision':
      await send(() =>
        client.send(
          new UpdateKinesisStreamingDestinationCommand({
            TableName: tableName,
            StreamArn: op.streamArn,
            UpdateKinesisStreamingConfiguration: {
              ApproximateCreationDateTimePrecision:
                op.precision as ApproximateCreationDateTimePrecision,
            },
          })
        )
      );
      break;
    case 'putTablePolicy':
    case 'putStreamPolicy': {
      const arn = await arnFor(op.kind === 'putTablePolicy' ? 'tableArn' : 'streamArn');
      await send(() =>
        client.send(new PutResourcePolicyCommand({ ResourceArn: arn, Policy: op.document }))
      );
      break;
    }
    case 'deleteTablePolicy':
    case 'deleteStreamPolicy': {
      // No stream left means no stream policy left: the goal.
      if (op.kind === 'deleteStreamPolicy' && (await describe()).streamArn === undefined) break;
      const arn = await arnFor(op.kind === 'deleteTablePolicy' ? 'tableArn' : 'streamArn');
      try {
        await send(() => client.send(new DeleteResourcePolicyCommand({ ResourceArn: arn })));
      } catch (error) {
        // No policy left to remove is the goal.
        if (!(error instanceof PolicyNotFoundException)) throw error;
      }
      break;
    }
    case 'indexContributorInsights':
      await send(() =>
        client.send(
          new UpdateContributorInsightsCommand({
            TableName: tableName,
            IndexName: op.indexName,
            ContributorInsightsAction: op.action,
            ...(op.mode !== undefined && {
              ContributorInsightsMode: op.mode as ContributorInsightsMode,
            }),
          })
        )
      );
      break;
    case 'untagStream': {
      // No stream left means no stream tags left: the goal.
      if ((await describe()).streamArn === undefined) break;
      const arn = await arnFor('streamArn');
      await send(() =>
        client.send(new UntagResourceCommand({ ResourceArn: arn, TagKeys: op.keys }))
      );
      break;
    }
    case 'tagStream': {
      const arn = await arnFor('streamArn');
      await send(() => client.send(new TagResourceCommand({ ResourceArn: arn, Tags: op.tags })));
      break;
    }
  }
  this.logger.debug(maskSecrets(`Applied ${op.kind} to ${scope}`));
}

/**
 * Retry a call DynamoDB refused only because an earlier change on the table
 * is still settling ("Backups are being enabled ... retry later",
 * `ResourceInUseException`, `LimitExceededException`). Bounded (about two
 * minutes) and interruptible, like the other waits here.
 */
export async function retrySettlingRefusal(
  this: DynamoDBGlobalTableProvider,
  call: () => Promise<unknown>,
  label: string,
  maskSecrets: SecretMasker
): Promise<void> {
  const watch = startInterruptWatch(maskSecrets(`DynamoDB ${label}`));
  try {
    let delayMs = SETTLING_RETRY_INITIAL_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await call();
        return;
      } catch (error) {
        const detail = describeAwsFailure(error).detail;
        const name = error instanceof Error ? error.name : '';
        const settling =
          /being enabled|being updated|please retry later|backups are being/i.test(detail) ||
          name === 'ResourceInUseException' ||
          name === 'LimitExceededException';
        if (!settling || attempt >= SETTLING_RETRY_ATTEMPTS) throw error;
        this.logger.debug(
          maskSecrets(
            `Transient refusal of ${label} (attempt ${attempt}/${SETTLING_RETRY_ATTEMPTS}): ` +
              `${detail} - retrying in ${delayMs}ms`
          )
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (watch.isInterrupted()) throw watch.onInterrupted();
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  } finally {
    watch.dispose();
  }
}

/**
 * Step 3's `TableClass` / `SSESpecification` call, each alone, waited out
 * across the global table. A template change that fails fails the update;
 * a correction AWS alone asked for is reported and left for the next
 * update (go-to-k/cdkd#5355).
 */
export async function sendLocalSettingUpdate(
  this: DynamoDBGlobalTableProvider,
  input: UpdateTableCommandInput,
  fromTemplate: boolean,
  what: string,
  tableName: string,
  logicalId: string,
  maskSecrets: SecretMasker
): Promise<void> {
  try {
    // go-to-k/cdkd#5487: SSE is a table key; the other local settings sent
    // here (TableClass, the replication mode) are replica members.
    markUnsettled(input.SSESpecification !== undefined ? 'SSESpecification' : 'Replicas');
    await this.dynamoDBClient.send(new UpdateTableCommand(input));
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
  } catch (error) {
    if (fromTemplate || isInterruptedWaitError(error)) throw error;
    this.logger.debug(
      maskSecrets(
        `Could not bring the ${what} of ${tableName} to the declared one: ` +
          describeAwsFailure(error).detail
      )
    );
    this.logger.warn(
      maskSecrets(
        `${tableName} does not hold its declared ${what}, and setting it failed ` +
          `(${describeAwsFailure(error).summary}).` +
          relayedEncryptionChangeLimit(describeAwsFailure(error).detail) +
          ` The next deploy that updates this table tries again.`
      )
    );
  }
}

/**
 * Wait until the table, every replica it lists and its encryption all read
 * as settled — what a table-class, encryption or replica-key change leaves
 * in flux across the regions, and what the next change on the table is
 * refused until (go-to-k/cdkd#5355).
 */
export async function waitForGlobalTableSettled(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  maskSecrets: SecretMasker,
  opts: {
    // Also require this replica region's own table to read ACTIVE.
    region?: string;
    budget?: ElapsedBudget | undefined;
    maxPolls?: number;
    // `false` only for the compensation after a Ctrl-C, which must still
    // run; it stays bounded by `maxPolls`.
    interruptible?: boolean;
  } = {}
): Promise<void> {
  const wait = beginDeleteWait(opts.maxPolls ?? GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS, opts.budget);
  const watch = startInterruptWatch(
    maskSecrets(`DynamoDB global table ${tableName} settling after an update`)
  );
  try {
    while (wait.nextPoll()) {
      if (opts.interruptible !== false && watch.isInterrupted()) throw watch.onInterrupted();
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = response.Table;
      if (
        table?.TableStatus === 'ACTIVE' &&
        table.SSEDescription?.Status !== 'UPDATING' &&
        (table.Replicas ?? []).every((r) => r.ReplicaStatus === 'ACTIVE')
      ) {
        if (opts.region === undefined) return;
        const replica = await this.getRegionalClient(opts.region).send(
          new DescribeTableCommand({ TableName: tableName })
        );
        if (replica.Table?.TableStatus === 'ACTIVE') return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    watch.dispose();
  }
  throw new ProvisioningError(
    maskSecrets(
      `Table ${tableName} and its replicas did not settle within ${wait.pollsRun} polls${wait.note()}`
    ),
    'AWS::DynamoDB::GlobalTable',
    logicalId,
    tableName
  );
}

/**
 * `delete()`'s cross-region replica drop. Under `--remove-protection` the
 * replica's own deletion protection (go-to-k/cdkd#5355) is turned off first,
 * the same flag the local table's flip honours; without the flag AWS refuses
 * a protected replica's drop and that refusal propagates, as the local
 * table's `DeleteTable` refusal does.
 *
 * Observe-then-flip like the local flip (issue #1978): only a guard that was
 * ON and that this call turned off is put back, and only when AWS refused
 * the drop (or the wait before it failed) — once the drop is accepted the
 * replica is on its way out.
 * DynamoDB throttles a second deletion-protection change on one table
 * within {@link DELETION_PROTECTION_REFLIP_MS} of the first (measured
 * 2026-10-26: `ThrottlingException: Deletion protection setting for table X
 * modified within the previous 15000 milliseconds`), so the restore waits
 * that window out once before giving up and saying how to restore it.
 */
export async function dropReplicaForDelete(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  removeProtection: boolean,
  logicalId: string,
  budget: ElapsedBudget,
  maskSecrets: SecretMasker
): Promise<void> {
  let flippedOff = false;
  if (removeProtection) {
    try {
      const before = await this.getRegionalClient(region).send(
        new DescribeTableCommand({ TableName: tableName })
      );
      if (before.Table?.DeletionProtectionEnabled === true) {
        await this.sendReplicaDeletionProtection(tableName, region, false, logicalId, maskSecrets, {
          budget,
        });
        flippedOff = true;
      }
    } catch (flipError) {
      // A Ctrl-C in the wait before the write stops the destroy; nothing
      // was turned off yet, so there is nothing to put back.
      if (isInterruptedWaitError(flipError)) throw flipError;
      // Best-effort like the local flip: a guard left on makes the drop
      // below refuse, and that refusal is what the user sees.
      this.logger.debug(
        maskSecrets(
          `Could not disable DeletionProtectionEnabled on the ${region} replica of ${tableName}: ` +
            describeAwsFailure(flipError).detail
        )
      );
    }
    if (flippedOff) {
      // Outside the best-effort catch: the source refuses the drop until
      // the change settles, and a wait that runs out or is interrupted must
      // stop the delete — with the guard put back first.
      try {
        await this.waitForReplicaProtectionSettled(
          tableName,
          region,
          false,
          logicalId,
          maskSecrets,
          budget
        );
      } catch (waitError) {
        // The throttle wait runs even after a Ctrl-C: a replica left
        // unprotected costs more than 16 s.
        await this.restoreReplicaDeletionProtection(
          tableName,
          region,
          logicalId,
          maskSecrets,
          isInterruptedWaitError(waitError)
            ? 'the destroy was interrupted'
            : 'its deletion-protection change did not settle'
        );
        throw waitError;
      }
    }
  }
  try {
    await this.dynamoDBClient.send(
      new UpdateTableCommand({
        TableName: tableName,
        ReplicaUpdates: [{ Delete: { RegionName: region } }],
      })
    );
  } catch (dropError) {
    if (flippedOff) {
      await this.restoreReplicaDeletionProtection(
        tableName,
        region,
        logicalId,
        maskSecrets,
        'it could not be dropped'
      );
    }
    throw dropError;
  }
}

/** {@link dropReplicaForDelete}'s compensation; never throws. */
export async function restoreReplicaDeletionProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  logicalId: string,
  maskSecrets: SecretMasker,
  // Why the delete stopped, as the warning states it.
  reason: string
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      // Settled first like every protection write, but this compensation
      // runs after a Ctrl-C or a wait that ran out too: the wait is short,
      // not interruptible, runs once (the throttle retry already waited
      // out its window), and the write is attempted whatever it found.
      if (attempt === 1) {
        await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, {
          region,
          maxPolls: REPLICA_PROTECTION_SETTLE_POLLS,
          interruptible: false,
        }).catch(() => undefined);
      }
      await this.writeReplicaDeletionProtection(tableName, region, true);
      return;
    } catch (restoreError) {
      if (
        attempt === 1 &&
        restoreError instanceof Error &&
        restoreError.name === 'ThrottlingException'
      ) {
        await new Promise((resolve) => setTimeout(resolve, DELETION_PROTECTION_REFLIP_MS));
        continue;
      }
      try {
        // The class at warn, AWS's text at debug (go-to-k/cdkd#2319).
        this.logger.debug(
          maskSecrets(
            `Could not restore DeletionProtectionEnabled on the ${region} replica of ` +
              `${tableName}: ${describeAwsFailure(restoreError).detail}`
          )
        );
        const head = maskSecrets(
          `The ${region} replica of ${tableName} was not deleted (${reason}), and its ` +
            `deletion protection, which this destroy turned off, could not be turned back on ` +
            `(${describeAwsFailure(restoreError).summary}). It is LEFT UNPROTECTED. ` +
            `To restore it, run: `
        );
        const command = pasteableAwsCommand(
          maskSecrets
        )`aws dynamodb update-table --table-name ${tableName} --deletion-protection-enabled --region ${region}`.render();
        this.logger.warn(safeMsg`${head}${command}`);
      } catch {
        // A throwing logger must not replace the drop error on its way out.
      }
      return;
    }
  }
}

/**
 * Poll the replica REGION for its same-named table until it is gone,
 * answering `true` once it is (so the replica-add may be retried) and
 * `false` for anything that is not a copy on its way out: a table in any
 * status but `DELETING`, a probe error, or the cap running out. Only ever
 * READS the region — the caller re-throws AWS's own refusal on `false`.
 * Interruptible, like every other bounded wait on this provider's paths.
 */
export async function waitForRegionalCopyReleased(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  // Both lines below name the RESOLVED table name, and the debug one quotes
  // AWS's error text, which often echoes it (issue #1997's contract).
  maskSecrets: SecretMasker
): Promise<boolean> {
  const client = this.getRegionalClient(region);
  // Masked: the label reaches the user in `InterruptedWaitError`'s message
  // on Ctrl-C, and `tableName` is the resolved name.
  const watch = startInterruptWatch(
    maskSecrets(`DynamoDB ${region} copy of ${tableName} to finish deleting`)
  );
  let announced = false;
  try {
    for (let poll = 0; poll < REPLICA_COPY_RELEASE_POLLS; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      let status: string | undefined;
      try {
        const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
        status = response.Table?.TableStatus;
      } catch (probeError) {
        if (probeError instanceof ResourceNotFoundException) return true;
        this.logger.debug(
          maskSecrets(
            `Could not read the ${region} copy of ${tableName}: ${describeAwsFailure(probeError).detail}`
          )
        );
        return false;
      }
      if (status !== 'DELETING') return false;
      if (!announced) {
        this.logger.info(
          maskSecrets(
            `The ${region} copy of ${tableName} is still being deleted; waiting for it before adding the replica`
          )
        );
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, REPLICA_COPY_RELEASE_POLL_MS));
    }
    return false;
  } finally {
    watch.dispose();
  }
}
