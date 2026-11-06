import {
  DynamoDBClient,
  DescribeTableCommand,
  UpdateTableCommand,
  type ReplicationGroupUpdate,
  type CreateReplicationGroupMemberAction,
  type ReplicaDescription,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { beginDeleteWait } from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import type { SecretMasker } from '../../../types/resource.js';
import { markAttemptedItems, markUnsettled, isUnsettled } from './projection.js';
import {
  DISASSOCIATION_PROTECTION_KEY,
  isMultiRegionReplicaSet,
  readReplicaDisassociationProtection,
  localReplicaEntry,
  readReplicaKmsMasterKeyId,
  readReplicaTableClass,
  UNUSABLE,
  readReplicaDeletionProtection,
} from './replica-shape.js';
import {
  REPLICA_COPY_RELEASE_POLL_MS,
  REPLICA_PROTECTION_SETTLE_POLLS,
  REPLICA_PROTECTION_SETTLE_POLL_MS,
  REPLICA_COPY_RELEASE_ATTEMPTS,
  isReplicaCopyExistsRefusal,
  asRecord,
} from './capacity.js';
import type { ThroughputDiagnostic } from './throughput.js';
import { toSdkReplicaGlobalSecondaryIndexes, toSdkReplicaThroughputOverrides } from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * Add a single replica region. Issues one `UpdateTableCommand` with
 * `ReplicaUpdates: [{ Create: { RegionName, ... } }]` and polls
 * `DescribeTable` until the replica's `ReplicaStatus` flips to ACTIVE.
 * Capped at 10 minutes per replica (AWS Replica provisioning typically
 * takes 1–5 min).
 *
 * `CreateReplicationGroupMemberAction` has no member for a replica's
 * point-in-time recovery, Contributor Insights (the table's or an index's),
 * Kinesis destination, resource policies or stream tags:
 * {@link applyReplicaSettings} sends those through the replica's own region
 * once every replica is ACTIVE (go-to-k/cdkd#5365, go-to-k/cdkd#5489).
 */
export async function addReplica(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  replica: Record<string, unknown>,
  region: string,
  logicalId: string,
  billingMode: string,
  diagnostics?: ThroughputDiagnostic[],
  // Threaded from both call sites (`create` / `update`), which each hold the
  // contract's `context?.maskSecrets`. Identity default keeps the
  // "absent means unmasked" contract for any future caller (issue #2178).
  maskSecrets: SecretMasker = (text) => text
): Promise<void> {
  const create: CreateReplicationGroupMemberAction = {
    RegionName: region,
  };
  // CFn spellings `SSESpecification.KMSMasterKeyId` / `TableClass`, not the
  // SDK member names (go-to-k/cdkd#5355).
  const kmsMasterKeyId = readReplicaKmsMasterKeyId(replica);
  if (kmsMasterKeyId !== undefined) {
    create.KMSMasterKeyId = kmsMasterKeyId;
  }
  // Replica-level GSI overrides. The CFn
  // `ReplicaGlobalSecondaryIndexSpecification` spells the per-replica read
  // throughput `Read{Provisioned,OnDemand}ThroughputSettings`, while the SDK
  // wants `{Provisioned,OnDemand}ThroughputOverride` — translate (Issue #1387).
  const replicaIndexes = toSdkReplicaGlobalSecondaryIndexes(
    replica['GlobalSecondaryIndexes'],
    billingMode,
    diagnostics,
    maskSecrets
  );
  if (replicaIndexes) {
    create.GlobalSecondaryIndexes = replicaIndexes;
  }
  // The replica's own TABLE-level read ceiling / read capacity, which uses
  // the SAME two CFn spellings one level up (issue #1436). A non-local
  // replica's `ReadOnDemandThroughputSettings` was dropped entirely before
  // this — the replica silently kept the source table's default.
  const tableOverrides = toSdkReplicaThroughputOverrides(
    replica,
    billingMode,
    diagnostics,
    {},
    maskSecrets
  );
  if (tableOverrides.ProvisionedThroughputOverride) {
    create.ProvisionedThroughputOverride = tableOverrides.ProvisionedThroughputOverride;
  }
  if (tableOverrides.OnDemandThroughputOverride) {
    create.OnDemandThroughputOverride = tableOverrides.OnDemandThroughputOverride;
  }
  const tableClass = readReplicaTableClass(replica);
  if (tableClass !== undefined) {
    create.TableClassOverride = tableClass;
  }

  const replicaUpdates: ReplicationGroupUpdate[] = [{ Create: create }];

  // A refusal because the region still holds a same-named table is retried
  // ONLY after that table is confirmed to be going away (issue #3569): a
  // table this provider just deleted leaves its regional copy DELETING for
  // minutes after it has left the source's `Replicas[]`, which is all
  // `delete()` waits for. A reverse-replacement rollback re-creates the old
  // table under its old name straight after deleting it, so it hits exactly
  // that window. Anything but DELETING is re-thrown untouched — a live table
  // of that name is not cdkd's to wait out, let alone remove.
  for (let attempt = 1; ; attempt++) {
    try {
      markUnsettled('Replicas');
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: tableName,
          ReplicaUpdates: replicaUpdates,
        })
      );
      // go-to-k/cdkd#5498: AWS accepted the replica Create.
      markAttemptedItems('Replicas', [region]);
      break;
    } catch (error) {
      if (attempt >= REPLICA_COPY_RELEASE_ATTEMPTS || !isReplicaCopyExistsRefusal(error)) {
        throw error;
      }
      if (!(await this.waitForRegionalCopyReleased(tableName, region, maskSecrets))) throw error;
      // One more interval AFTER the region reports the copy gone: the source
      // table's own view of the region can trail the region itself, which is
      // the lag this retry exists for, and a copy found gone on the FIRST poll
      // would otherwise be retried at once.
      await new Promise((resolve) => setTimeout(resolve, REPLICA_COPY_RELEASE_POLL_MS));
    }
  }

  await this.waitForReplicaActive(tableName, region, logicalId, undefined, maskSecrets);

  // DynamoDB takes `ProvisionedThroughputOverride` on a replica `Create` and
  // drops it: the region comes up ACTIVE at the source's read with no override,
  // and stays there. The same override on an `Update` holds (measured,
  // go-to-k/cdkd#5604), which is what CloudFormation's result needs.
  const provisionedIndexes = replicaIndexes?.filter((i) => i.ProvisionedThroughputOverride);
  if (create.ProvisionedThroughputOverride || provisionedIndexes?.length) {
    // The replica reads ACTIVE while the table still reads UPDATING.
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
    await this.dynamoDBClient.send(
      new UpdateTableCommand({
        TableName: tableName,
        ReplicaUpdates: [
          {
            Update: {
              RegionName: region,
              ...(create.ProvisionedThroughputOverride && {
                ProvisionedThroughputOverride: create.ProvisionedThroughputOverride,
              }),
              ...(provisionedIndexes?.length && { GlobalSecondaryIndexes: provisionedIndexes }),
            },
          },
        ],
      })
    );
    await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
  }

  // `CreateReplicationGroupMemberAction` has no deletion-protection member,
  // so a cross-region replica's `DeletionProtectionEnabled` is set on the
  // replica's own table in its own region once it exists. A new replica
  // starts unprotected, so only `true` needs a call (go-to-k/cdkd#5355).
  const protect = readReplicaDeletionProtection(replica, region, (message) =>
    this.logger.warn(maskSecrets(message))
  );
  if (protect === true) {
    await this.setReplicaDeletionProtection(tableName, region, true, logicalId, maskSecrets);
  }
}

/**
 * Set `DeletionProtectionEnabled` on a CROSS-REGION replica: an
 * `UpdateTable` against the replica's table through the region-scoped
 * client, since the source table's `ReplicaUpdates` cannot carry it
 * (go-to-k/cdkd#5355). Then waits for the change to settle — see
 * {@link waitForReplicaProtectionSettled}.
 */
export async function setReplicaDeletionProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  enabled: boolean,
  logicalId: string,
  maskSecrets: SecretMasker,
  budget?: ElapsedBudget
): Promise<void> {
  await this.sendReplicaDeletionProtection(tableName, region, enabled, logicalId, maskSecrets, {
    budget,
  });
  await this.waitForReplicaProtectionSettled(
    tableName,
    region,
    enabled,
    logicalId,
    maskSecrets,
    budget
  );
}

/**
 * The protection write itself, after the table and every replica — this
 * replica's own table included — read settled: a change still in flight
 * (a key, class or protection change moments earlier) makes DynamoDB refuse
 * it with `ResourceInUseException` (integ, 2026-10-27: the auto-disable
 * straight after a key / class update was refused that way).
 */
export async function sendReplicaDeletionProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  enabled: boolean,
  logicalId: string,
  maskSecrets: SecretMasker,
  opts: { budget?: ElapsedBudget | undefined } = {}
): Promise<void> {
  await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets, { ...opts, region });
  await this.writeReplicaDeletionProtection(tableName, region, enabled);
}

export async function writeReplicaDeletionProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  enabled: boolean
): Promise<void> {
  markUnsettled('Replicas');
  await this.getRegionalClient(region).send(
    new UpdateTableCommand({ TableName: tableName, DeletionProtectionEnabled: enabled })
  );
}

/**
 * Wait for a replica's deletion-protection change to land. On a
 * cross-region replica the change puts BOTH the replica's table and the
 * source table into `UPDATING` for about 30 s, the new value reads back
 * only once the replica is `ACTIVE` again, and the source refuses a replica
 * update or drop meanwhile with `ResourceInUseException` (measured
 * us-east-1 + us-west-2, 2026-10-26). Bounded and interruptible like the
 * other waits here; on the delete path it spends the shared allowance.
 */
export async function waitForReplicaProtectionSettled(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  enabled: boolean,
  logicalId: string,
  maskSecrets: SecretMasker,
  budget?: ElapsedBudget,
  // go-to-k/cdkd#5570: the disassociation-protection pass waits the same
  // way, on the replica region's own table (the local one included).
  member:
    | 'DeletionProtectionEnabled'
    | 'DisassociationProtectionEnabled' = 'DeletionProtectionEnabled',
  replicaClient: DynamoDBClient = this.getRegionalClient(region)
): Promise<void> {
  const wait = beginDeleteWait(REPLICA_PROTECTION_SETTLE_POLLS, budget);
  const what =
    member === 'DeletionProtectionEnabled' ? 'deletion-protection' : 'disassociation-protection';
  const watch = startInterruptWatch(
    maskSecrets(`DynamoDB replica ${region} ${what} change on ${tableName}`)
  );
  try {
    while (wait.nextPoll()) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const replica = await replicaClient.send(new DescribeTableCommand({ TableName: tableName }));
      if (replica.Table?.TableStatus === 'ACTIVE' && replica.Table[member] === enabled) {
        const source = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        if (source.Table?.TableStatus === 'ACTIVE') return;
      }
      await new Promise((resolve) => setTimeout(resolve, REPLICA_PROTECTION_SETTLE_POLL_MS));
    }
  } finally {
    watch.dispose();
  }
  throw new ProvisioningError(
    maskSecrets(
      `${member}=${enabled} on the ${region} replica of ${tableName} did not ` +
        `settle within ${wait.pollsRun} polls${wait.note()}`
    ),
    'AWS::DynamoDB::GlobalTable',
    logicalId,
    tableName
  );
}

/**
 * `update()`'s cross-region `Replicas[].DeletionProtectionEnabled` pass
 * (go-to-k/cdkd#5355), over every replica the update KEEPS — one it just
 * added already took its setting in {@link addReplica}.
 *
 * A template-side change is sent, an absent value reading as `false` (what
 * CloudFormation leaves after the member is removed, and what a new replica
 * starts with). A DECLARED value the template did not change is checked
 * against AWS, the twin of the local table's AWS-aware diff: before this
 * issue the setting was never sent, so a replica deployed then holds `false`
 * under a record saying `true`, and only a read converges it (a console-side
 * enable under a declared `false` likewise). That read is best-effort — a
 * failure leaves the replica as it is. A value that is not a boolean is
 * reported and the replica's protection left alone, never read as `false`.
 */
export async function convergeReplicaDeletionProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  currentRegion: string,
  previousProperties: Record<string, unknown>,
  properties: Record<string, unknown>,
  addedRegions: ReadonlySet<unknown>,
  // `drift --revert`: the desired side is a read-back, which omits a
  // replica's protection when its regional read failed (go-to-k/cdkd#5381)
  // — an absence there is unknown, never "unprotect".
  desiredFromReadback: boolean,
  warn: (message: string) => void,
  maskSecrets: SecretMasker
): Promise<void> {
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  for (const entry of desired) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region !== 'string' || region === currentRegion || addedRegions.has(region)) {
      continue;
    }
    const declared = readReplicaDeletionProtection(replica, region, warn);
    if (declared === UNUSABLE) continue;
    if (declared === undefined && desiredFromReadback) continue;
    const previous = readReplicaDeletionProtection(
      localReplicaEntry(previousProperties, region),
      region
    );
    const newDpe = declared ?? false;
    const oldDpe = previous === UNUSABLE ? undefined : (previous ?? false);
    if (oldDpe !== undefined && newDpe !== oldDpe) {
      if (oldDpe && declared === undefined) {
        // The local table's auto-disable warning, for the same footgun: a
        // dropped `deletionProtection` line turns the guard off.
        warn(
          `Auto-disabling DeletionProtectionEnabled on the ${region} replica of ` +
            `${tableName}: the template no longer sets it for that replica. Set it ` +
            `to false explicitly to silence this warning.`
        );
      }
      await this.setReplicaDeletionProtection(tableName, region, newDpe, logicalId, maskSecrets);
      continue;
    }
    // Only a DECLARED value is converged against AWS; an absent one with an
    // unreadable record has no change to send and nothing to assert.
    if (declared === undefined) continue;
    let live: boolean | undefined;
    try {
      const described = await this.getRegionalClient(region).send(
        new DescribeTableCommand({ TableName: tableName })
      );
      live = described.Table?.DeletionProtectionEnabled;
    } catch (readError) {
      this.logger.debug(
        maskSecrets(
          `Could not read DeletionProtectionEnabled on the ${region} replica of ${tableName}: ` +
            describeAwsFailure(readError).detail
        )
      );
    }
    if (typeof live === 'boolean' && live !== newDpe) {
      await this.setReplicaDeletionProtection(tableName, region, newDpe, logicalId, maskSecrets);
    }
  }
}

/**
 * Each replica's declared `Replicas[].DisassociationProtectionEnabled`, the
 * local table's included (go-to-k/cdkd#5570). DynamoDB takes it only as an
 * `UpdateTable` of the replica's own table, in its own region, that changes
 * nothing else, so it is one solo write per replica, made once every other
 * change of the create or update has settled.
 *
 * AWS-aware: a replica already holding the declared value gets no write.
 * The protection is on by default for every replica (DynamoDB Developer
 * Guide, "Disassociating a global table replica"), so a declared `true`
 * usually costs one read. A value the template changed, or declares on a
 * replica this deploy creates, is sent when that read fails or reports no
 * value; an unchanged one is only converged against a value AWS reports, so
 * a failed read leaves the replica as it is.
 *
 * A REMOVED value sends nothing: an `UpdateTable` that omits the member
 * leaves the setting unchanged, so the replica keeps it, and the template
 * path says so (CloudFormation's behaviour on removal is unmeasured). A
 * state replay is the exception: its desired side is the record an earlier
 * deploy left, and a record without the member stands for the AWS default,
 * so when the rolled-back deploy declared `false` and AWS reads `false`,
 * the replay sends `true` — a rollback never leaves the protection weaker
 * than the record it restores. It does not ask whether that deploy got as
 * far as sending its `false`: a `false` set outside cdkd, which the record
 * does not declare either, is turned back on as well, the way the replay
 * restores every other recorded setting. A drift revert sends nothing for
 * an absence: a read-back omits a member whose read failed.
 *
 * The protection guards only the `Disassociate` replica action, which cdkd
 * never sends; deletion protection is the guard of a replica removal and of
 * `DeleteTable`, so no delete path reads this one.
 */
export async function convergeReplicaDisassociationProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  currentRegion: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  origin: 'template' | 'replay' | 'readback',
  warn: (message: string) => void,
  maskSecrets: SecretMasker
): Promise<void> {
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  let wrote = false;
  // A single-Region table takes no write at all: DynamoDB answered the solo
  // UpdateTable {false} with a 500 there. A new or changed `false` was
  // refused (or, on a replay or a revert, warned) up front by
  // disassociationProtectionRefusal; a `true` and an unchanged `false` are
  // skipped here.
  const multiRegion = isMultiRegionReplicaSet(properties);
  for (const entry of desired) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region !== 'string' || region === '') continue;
    const declared = readReplicaDisassociationProtection(replica);
    const previous =
      previousProperties === undefined
        ? undefined
        : readReplicaDisassociationProtection(localReplicaEntry(previousProperties, region));
    // Resolved only for a replica the pass reads: a region-scoped client is
    // never built for one that declares nothing.
    const clientFor = (): DynamoDBClient =>
      region === currentRegion ? this.dynamoDBClient : this.getRegionalClient(region);
    const readLive = async (): Promise<boolean | undefined> => {
      const client = clientFor();
      try {
        const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
        return described.Table?.DisassociationProtectionEnabled;
      } catch (readError) {
        this.logger.debug(
          maskSecrets(
            `Could not read ${DISASSOCIATION_PROTECTION_KEY} on the ${region} replica of ` +
              `${tableName}: ${describeAwsFailure(readError).detail}`
          )
        );
        return undefined;
      }
    };
    if (!multiRegion) {
      if (declared !== undefined) {
        const message =
          `${DISASSOCIATION_PROTECTION_KEY}=${declared} on the ${region} replica of ` +
          `${tableName} is not sent: DynamoDB applies it only to a replica of a multi-Region ` +
          "global table, and this table's Replicas name a single Region.";
        // Said once, in the deploy that leaves one Region or that declares
        // or changes the value; afterwards it is the steady state, at debug.
        const justShrunk =
          previousProperties !== undefined && isMultiRegionReplicaSet(previousProperties);
        if (origin === 'template' && (justShrunk || declared !== previous)) warn(message);
        else this.logger.debug(maskSecrets(message));
      } else if (
        origin !== 'readback' &&
        replica?.[DISASSOCIATION_PROTECTION_KEY] === undefined &&
        previous !== undefined
      ) {
        // Nothing can be sent here, the template's removal and a replay's
        // restore alike: say what the replica keeps.
        warn(
          `${DISASSOCIATION_PROTECTION_KEY} was removed from the ${region} replica of ` +
            `${tableName}, whose Replicas now name a single Region, so nothing is sent and ` +
            `the replica keeps its current setting (${previous} when last deployed).`
        );
      }
      continue;
    }
    if (declared === undefined) {
      if (replica?.[DISASSOCIATION_PROTECTION_KEY] !== undefined || previous === undefined) {
        continue;
      }
      if (origin === 'template') {
        warn(
          `${DISASSOCIATION_PROTECTION_KEY} was removed from the ${region} replica of ` +
            `${tableName}; DynamoDB keeps the replica's current setting (${previous} when ` +
            `last deployed), so nothing is sent. Declare it to change it.`
        );
      } else if (origin === 'replay' && previous === false && (await readLive()) === false) {
        await this.setReplicaDisassociationProtection(
          tableName,
          region,
          clientFor(),
          true,
          logicalId,
          maskSecrets
        );
        wrote = true;
      }
      continue;
    }
    // go-to-k/cdkd#5487: an earlier update that failed part-way may have
    // left a write unsent, so an unsettled `Replicas` counts as a change
    // and is sent even when this deploy's read fails.
    const changed = declared !== previous || isUnsettled('Replicas');
    const live = await readLive();
    if (live === declared) continue;
    if (live === undefined && !changed) continue;
    await this.setReplicaDisassociationProtection(
      tableName,
      region,
      clientFor(),
      declared,
      logicalId,
      maskSecrets
    );
    wrote = true;
  }
  // The replica-scoped wait above does not read the other replicas'
  // statuses, and the steps after this pass (TTL, the index updates,
  // auto-scaling) are refused with `ResourceInUseException` while any is
  // still UPDATING: settle the whole table before handing it on.
  if (wrote) await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
}

/**
 * The solo disassociation-protection write on one replica's own table, once
 * the table and every replica read settled (a change still in flight makes
 * DynamoDB refuse it with `ResourceInUseException`, as it refuses the
 * deletion-protection write), then the wait for the value to read back —
 * see {@link waitForReplicaProtectionSettled}.
 */
export async function setReplicaDisassociationProtection(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  client: DynamoDBClient,
  enabled: boolean,
  logicalId: string,
  maskSecrets: SecretMasker
): Promise<void> {
  await this.waitForGlobalTableSettled(
    tableName,
    logicalId,
    maskSecrets,
    client === this.dynamoDBClient ? {} : { region }
  );
  // A refusal propagates as the deletion-protection write's does: the
  // caller's masked wrap names its class, never AWS's text (#2319).
  markUnsettled('Replicas');
  this.logger.debug(
    maskSecrets(
      `Sending UpdateTable ${DISASSOCIATION_PROTECTION_KEY}=${enabled} to the ${region} replica of ${tableName}`
    )
  );
  await client.send(
    new UpdateTableCommand({ TableName: tableName, DisassociationProtectionEnabled: enabled })
  );
  await this.waitForReplicaProtectionSettled(
    tableName,
    region,
    enabled,
    logicalId,
    maskSecrets,
    undefined,
    DISASSOCIATION_PROTECTION_KEY,
    client
  );
}

/**
 * `update()`'s AWS-aware pass over the KEPT cross-region replicas' declared
 * `TableClass` (go-to-k/cdkd#5355). The diff-driven replica update only
 * fires on a template change, but a replica deployed before this issue
 * holds `STANDARD` under a record that already names the declared class —
 * so the two sides match and only AWS can say the replica is wrong. Read
 * from ONE source `DescribeTable` after the replica updates ran, which
 * reports each replica's class. The KMS keys are {@link applyReplicaKeys}'.
 */
export async function convergeReplicaSettings(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  currentRegion: string,
  properties: Record<string, unknown>,
  addedRegions: ReadonlySet<unknown>,
  maskSecrets: SecretMasker
): Promise<void> {
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  const kept = desired
    .map(asRecord)
    .filter(
      (r): r is Record<string, unknown> =>
        typeof r?.['Region'] === 'string' &&
        r['Region'] !== currentRegion &&
        !addedRegions.has(r['Region'])
    );
  if (kept.every((r) => readReplicaTableClass(r) === undefined)) return;
  let liveReplicas: ReplicaDescription[] | undefined;
  let sourceClass: string | undefined;
  try {
    const described = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    liveReplicas = described.Table?.Replicas;
    sourceClass = described.Table?.TableClassSummary?.TableClass;
  } catch (readError) {
    this.logger.debug(
      maskSecrets(
        `Could not read the replicas of ${tableName} to converge their table class: ` +
          describeAwsFailure(readError).detail
      )
    );
    return;
  }
  for (const replica of kept) {
    const region = replica['Region'] as string;
    const live = liveReplicas?.find((r) => r.RegionName === region);
    if (!live) continue;
    const tableClass = readReplicaTableClass(replica);
    if (tableClass === undefined) continue;
    // A replica without its own class summary inherits the source table's.
    const liveClass = live.ReplicaTableClassSummary?.TableClass ?? sourceClass ?? 'STANDARD';
    if (tableClass === liveClass) {
      this.logger.debug(
        maskSecrets(`The ${region} replica of ${tableName} already holds its declared table class`)
      );
      continue;
    }
    this.logger.debug(
      maskSecrets(`Bringing the ${region} replica of ${tableName} to its declared table class`)
    );
    // Best-effort: this corrects a replica the TEMPLATE did not change, so
    // a refusal must not fail a deploy that would otherwise succeed. It is
    // reported; this pass runs again on the table's next update.
    try {
      markUnsettled('Replicas');
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: tableName,
          ReplicaUpdates: [{ Update: { RegionName: region, TableClassOverride: tableClass } }],
        })
      );
      // The whole table, so the key pass after this is not refused.
      await this.waitForGlobalTableSettled(tableName, logicalId, maskSecrets);
    } catch (convergeError) {
      if (isInterruptedWaitError(convergeError)) throw convergeError;
      this.logger.debug(
        maskSecrets(
          `Could not bring the ${region} replica of ${tableName} to its declared table class: ` +
            describeAwsFailure(convergeError).detail
        )
      );
      this.logger.warn(
        maskSecrets(
          `The ${region} replica of ${tableName} does not hold its declared TableClass, and ` +
            `setting it failed (${describeAwsFailure(convergeError).summary}). The next deploy ` +
            `that updates this table tries again.`
        )
      );
    }
  }
}
