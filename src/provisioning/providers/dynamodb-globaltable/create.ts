import {
  CreateTableCommand,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalTableSettingsReplicationMode,
  type LocalSecondaryIndex,
  type OnDemandThroughput,
  type StreamSpecification,
  type Tag,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';

import { ProvisioningError } from '../../../utils/error-handler.js';

import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import {
  configBooleanRefusal,
  readConfigString,
  replayWarn,
  requireConfigString,
} from '../../config-shape.js';
import { coerceWarmThroughput } from '../../dynamodb-warm-throughput.js';
import { vectorIndexesForCreate } from '../../dynamodb-vector-indexes.js';

import type { ResourceCreateResult, CreateContext, SecretMasker } from '../../../types/resource.js';
import {
  refuseMalformedReplicaTags,
  disassociationProtectionRefusal,
  localReplicaEntry,
  readReplicationMode,
  replicaSettingsRefusal,
  extractLocalDeletionProtection,
  readReplicaKmsMasterKeyId,
  toSdkTableSseSpecification,
  extractLocalTableClass,
} from './replica-shape.js';
import {
  derivePerCallProvisionedThroughput,
  withdrawReplicaIndexBlocks,
  STREAM_SPECIFICATION_KEY,
  replicationImpliedStreamSpecification,
  collectDesiredKeyAttributeNames,
  asRecord,
  type AutoScalingTargetSpec,
} from './capacity.js';
import { warmThroughputDiagnostic, type ThroughputDiagnostic } from './throughput.js';
import { toSdkGlobalSecondaryIndexes, stripProvisionedCapacityKeys } from './gsi.js';
import {
  toSdkReplicaGlobalSecondaryIndexes,
  toSdkReplicaThroughputOverrides,
  collectTableOnDemandCeilings,
} from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import { createPhaseCommit } from './create-commit.js';
import type { VectorIndex } from '@aws-sdk/client-dynamodb';
import type { CfnTagEntry } from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

/**
 * The `create` parameters and locals its final phase reads; that phase is the body's last statement, moved verbatim.
 */
export interface CreateLocals {
  tableName: string;
  logicalId: string;
  maskSecrets: SecretMasker;
  createVectorIndexes: VectorIndex[] | undefined;
  billingMode: string;
  wiringProperties: Record<string, unknown>;
  currentRegion: string;
  wiringReplicas: Record<string, unknown>[];
  registeredBeforeReplicas: AutoScalingTargetSpec[];
  replicas: Record<string, unknown>[];
  desiredReplicaTags: Map<Record<string, unknown>, CfnTagEntry[]>;
  resourceType: string;
  log: MaskedLogSinks;
  context: CreateContext | undefined;
  warn: (message: string) => void;
  properties: Record<string, unknown>;
  effectiveProperties: Record<string, unknown> | undefined;
  createdTableId: string | undefined;
}

/**
 * Create a DynamoDB Global Table (CDK TableV2).
 *
 * GlobalTable is built on the regular DynamoDB Table primitive: cdkd issues
 * `CreateTableCommand` first (which only creates the table in the local
 * region), waits for `ACTIVE`, then issues one `UpdateTableCommand` per
 * additional replica region via `ReplicaUpdates: [{ Create: {...} }]`.
 *
 * Streams must be enabled with `NEW_AND_OLD_IMAGES` when the table has any
 * cross-region replicas — AWS rejects the replica-add otherwise. cdkd
 * auto-enables them with an info log when the template omits it.
 *
 * Partial-create cleanup (PR #374-class): if any post-`CreateTableCommand`
 * wiring (wait ACTIVE → replica adds → TTL → Tags) throws, cdkd issues a
 * best-effort `DeleteTableCommand` so AWS is not left holding a billing
 * orphan with no cdkd state record. Cleanup failures escalate to WARN
 * with the exact `aws dynamodb delete-table --table-name <id>` recovery
 * command.
 */
export async function create(
  this: DynamoDBGlobalTableProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // The caller's secret masker (issue #1932 item 3, adopted here by issue
  // #1997), extended by the table-name needle (issue #2177). Read
  // defensively — `create()` is also called by the import path, by the
  // rollback executor's reverse-replacement arm, and by tests, so it must not
  // care which caller it got. Every line below goes through `log`.
  const log = this.operationSinks(context, [
    [properties['TableName'], properties['TableName'] as string | undefined],
  ]);
  const maskSecrets: SecretMasker = log.mask;
  const warn = log.warn;
  log.debug(`Creating DynamoDB GlobalTable ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed `Replicas[].Tags` is refused before any call.
  const desiredReplicaTags = refuseMalformedReplicaTags(properties, resourceType, logicalId);
  // go-to-k/cdkd#5570: a `Replicas[].DisassociationProtectionEnabled` that is
  // not a boolean is refused before any call; a state replay warns and
  // leaves that replica's protection as AWS has it.
  const disassociationRefusal = disassociationProtectionRefusal(properties, undefined, logicalId);
  if (disassociationRefusal !== undefined) {
    if (context?.replayingState !== true) {
      throw new ProvisioningError(log.mask(disassociationRefusal), resourceType, logicalId);
    }
    warn(`${disassociationRefusal} Proceeding: this create replays a cdkd state record.`);
  }

  const tableName =
    (properties['TableName'] as string | undefined) ||
    generatedNameFor('AWS::DynamoDB::GlobalTable', logicalId);
  const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
  const attributeDefinitions = properties['AttributeDefinitions'] as
    | AttributeDefinition[]
    | undefined;

  if (!keySchema) {
    throw new ProvisioningError(
      `KeySchema is required for DynamoDB GlobalTable ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  if (!attributeDefinitions) {
    throw new ProvisioningError(
      `AttributeDefinitions is required for DynamoDB GlobalTable ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // GlobalTable defaults to PAY_PER_REQUEST in CDK; respect explicit override.
  //
  // Guarded per issue #1513 — the last top-level `?? 'default'` site that
  // issue left open, because this file was owned by a parallel lane when the
  // rest shipped. `BillingMode` is ENUM-valued, so it does NOT take
  // `coerceNumber`: a number here is a template bug, not the unquoted-YAML
  // scalar CFn coerces. And the default it silently substitutes is the
  // consequential one — a `BillingMode: null` (or an intrinsic the resolver
  // could not resolve) on a template that says PROVISIONED would create an
  // ON-DEMAND table, with every `ProvisionedThroughput` block below dropped
  // by the billing gate and only a diagnostic to show for it.
  //
  // Wrapped the same way the `StreamSpecification` guard below is: the read
  // sits OUTSIDE `create()`'s try, so an unwrapped throw would escape untyped
  // into the deploy engine's retry loop.
  //
  // When the replay downgrade DOES fire, the substituted mode is what goes on
  // the wire, so it is what state must record (issue #1683, the #1653 sibling
  // for this arm): the table really is created PAY_PER_REQUEST, and recording
  // the malformed declared value instead leaves permanent phantom drift no
  // `--revert` can clear. Composed onto `replayWarn`'s own callback rather
  // than replacing it, and only when that callback EXISTS, so a template-path
  // create keeps refusing — the single-call-site exception `.claude/rules/
  // providers.md` licenses for a read of KNOWN warn-and-DEFAULT class.
  let billingMode: string;
  let billingModeSubstituted = false;
  let billingModeAbsentOnReplay = false;
  try {
    const billingReplayWarn = replayWarn(log, context).onUnusable;
    billingMode = requireConfigString(
      properties['BillingMode'],
      'PAY_PER_REQUEST',
      'AWS::DynamoDB::GlobalTable BillingMode',
      billingReplayWarn
        ? {
            onUnusable: (message) => {
              billingModeSubstituted = true;
              billingReplayWarn(message);
            },
          }
        : {}
    );
    // An ABSENT value is not malformed, so neither the refusal nor
    // `replayWarn` fires and PAY_PER_REQUEST applies silently. On a REPLAY
    // that absence can be one this provider's own update-path arm produced —
    // it DROPS the key when the record had none rather than inventing one —
    // so announce it, per `.claude/rules/providers.md`: a drop is only honest
    // while something still says so. `LambdaUrlProvider.create` carries the
    // same announcement for the same reason. A template-path create with a
    // legitimately absent `BillingMode` stays silent, since there the default
    // IS the declared intent.
    //
    // This is noisier than the Lambda URL precedent and that is accepted, not
    // overlooked: there the silent default is a PUBLIC function URL, here it
    // is `PAY_PER_REQUEST`, which is also CDK's own default — so most replays
    // this fires on are benign. It stays a warn because the alternative is a
    // drop nothing announces, and the one case it is NOT benign (a record
    // that lost the key while AWS holds PROVISIONED — issue #1733) is
    // invisible from here.
    if (billingReplayWarn && properties['BillingMode'] === undefined) {
      // The create resolves to PAY_PER_REQUEST here too, so the SAME capacity
      // blocks go unsent as in the substitute arm below (issue #1726 review).
      // Only the STRIP is shared: this arm deliberately does NOT record a
      // `BillingMode`, because whether an absent recorded mode may be
      // materialized is issue #1733's question, not this one's.
      billingModeAbsentOnReplay = true;
      warn(
        `AWS::DynamoDB::GlobalTable ${logicalId}: the state record declares no BillingMode, ` +
          `so this replay creates the table PAY_PER_REQUEST. If it was PROVISIONED, set the ` +
          `mode in the template and redeploy.`
      );
    }
  } catch (error) {
    // A cdkd-authored refusal: masked, never stamped (`wrapMaskedAwsError` is
    // for relayed AWS text only).
    throw new ProvisioningError(
      log.mask(describeAwsFailure(error).detail),
      resourceType,
      logicalId,
      undefined,
      error instanceof Error ? error : undefined
    );
  }

  const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
  const replicas = (properties['Replicas'] as Array<Record<string, unknown>> | undefined) ?? [];

  const createParams: CreateTableCommandInput = {
    TableName: tableName,
    KeySchema: keySchema,
    AttributeDefinitions: attributeDefinitions,
    BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
  };

  // The DESIRED side, so it collects diagnostics (issues #1428 / #1444 A /
  // #1511). Declared before the first translation below — every one of them
  // pushes into it, and they are all emitted BEFORE `CreateTable` (a
  // translation complaint must never arrive after a real table exists).
  const diagnostics: ThroughputDiagnostic[] = [];

  // ProvisionedThroughput: GlobalTable's CFn shape uses
  // `WriteProvisionedThroughputSettings` for write capacity and a
  // per-replica `ReadProvisionedThroughputSettings` for read capacity.
  // The base CreateTable call needs `ProvisionedThroughput` when
  // BillingMode=PROVISIONED. We pull WriteCapacityUnits from
  // `WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings`
  // when present, else default to 5/5. Read capacity is per-replica;
  // we use the deploy-region replica's setting when available.
  if (billingMode === 'PROVISIONED') {
    createParams.ProvisionedThroughput = derivePerCallProvisionedThroughput(
      properties,
      currentRegion,
      'min',
      diagnostics,
      maskSecrets
    );
  }

  // issue #1653: the bag actually delivered, when the replay downgrade above
  // or below substituted a value for a malformed declared one. `undefined`
  // (the normal case) means "record the desired properties".
  //
  // Two arms can fire in ONE create (a single state record carrying two
  // malformed values), so the LATER one composes onto whatever the earlier
  // recorded (`?? properties`) — that composition is live, not decorative,
  // and a unit test fences it (issue #1683). The FIRST arm assigns directly
  // because there is nothing yet to compose onto.
  //
  // The `needsStream` auto-enable further down is a third, and composes the
  // same way (issue #1723).
  let effectiveProperties: Record<string, unknown> | undefined;

  if (billingModeSubstituted) {
    // The twin question, re-asked here because this arm SUBSTITUTES rather
    // than skips and `.claude/rules/providers.md` requires it at every
    // substitute site: no `canonicalizeDesiredProperties` is needed.
    // `BillingMode` is not create-only, so the next deploy's diff sees a
    // changed value, classifies an ordinary in-place UPDATE, and the update
    // path's own guard answers it — no replacement is derived and nothing is
    // removed. Canonicalizing the desired side would instead make cdkd agree
    // with a malformed template forever.
    //
    // The substitution drops MORE than one key from the wire (issue #1726).
    // Sending PAY_PER_REQUEST also makes this create skip
    // `createParams.ProvisionedThroughput`, hand the SUBSTITUTED mode to
    // `toSdkGlobalSecondaryIndexes` (so every PROVISIONED-only per-index
    // member is dropped before `CreateTable`), and skip auto-scaling
    // registration. Recording the desired capacity blocks alongside the
    // substituted mode would leave the same permanent phantom drift this arm
    // exists to remove, one key over — so they are STRIPPED here.
    //
    // Which keys are safe to strip is answered by what `readCurrentState`
    // emits for a PAY_PER_REQUEST GlobalTable, per member, and every one of
    // those emissions is type-discriminator-gated on
    // `billingMode === 'PROVISIONED'` further down this file: the top-level
    // `WriteProvisionedThroughputSettings` emits `{}`, and the per-replica /
    // per-index / per-replica-index blocks are omitted entirely. So the
    // PROVISIONED-only set is exactly what `stripProvisionedCapacityKeys`
    // removes. The on-demand ceilings are deliberately NOT stripped: they go
    // on the wire under this very mode (`OnDemandThroughput` is attached when
    // `billingMode !== 'PROVISIONED'`), so what was SENT still describes them.
    //
    // No `canonicalizeDesiredProperties` twin is needed, and the reason is
    // the arm's own: this bag ALREADY records a `BillingMode` differing from
    // the malformed declared one, so the next deploy's diff ALREADY
    // classifies an in-place UPDATE (see the paragraph above). Stripping the
    // capacity keys folds into that same UPDATE rather than manufacturing a
    // new one, and once the template's mode is corrected the update path
    // re-sends the capacity settings normally. A twin would instead make cdkd
    // agree with a malformed template forever.
    effectiveProperties = stripProvisionedCapacityKeys({
      ...properties,
      BillingMode: billingMode,
    });
  } else if (billingModeAbsentOnReplay) {
    // The absent-mode replay sibling: same unsent capacity, same strip, but
    // the bag keeps whatever `BillingMode` the record had (i.e. none). See
    // the flag's own comment and issue #1733.
    effectiveProperties = stripProvisionedCapacityKeys(properties);
  }

  // Stream specification. GlobalTable cross-region replication requires
  // streams with NEW_AND_OLD_IMAGES. CDK synth always emits
  // `StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' }`
  // (verified via real `cdk synth` 2026-05-16); cdkd defensively forces
  // streams on when the template has more than one replica or any
  // non-local replica, even if the template was hand-authored without.
  const streamSpecInput = properties['StreamSpecification'] as Record<string, unknown> | undefined;
  const hasNonLocalReplica = replicas.some((r) => r['Region'] !== currentRegion);
  const needsStream = hasNonLocalReplica || replicas.length > 1;
  // `!= null` rather than a truthiness gate: `StreamSpecification: ''` is
  // exactly the malformed shape `readConfigString` exists to refuse, and a
  // falsy gate would skip the guard and silently fall through to the
  // auto-enable arm below (.claude/rules/providers.md, "cover the CREATE
  // path"). `create()` has no wrapping catch around this point, so the
  // helper's plain Error is converted here rather than escaping untyped
  // into the deploy engine's retry loop -- same treatment as the GSI
  // translation below.
  if (streamSpecInput != null) {
    let streamViewType: string;
    // issue #1653 (create-path sibling): a SUBSTITUTED value is the same
    // class as a dropped key (.claude/rules/providers.md, #1633) — under the
    // replay downgrade the deploy SUCCEEDS while the engine records the
    // MALFORMED desired block, so `readCurrentState` can never match it and
    // the difference is permanent phantom drift.
    //
    // This arm is NOT the "replay-CREATE -> DROP the key" case the #1612
    // carve-out describes: that answer is scoped to a SKIP, where nothing
    // reached AWS. Here the downgrade SUBSTITUTES the default and the block
    // IS applied — a stream really is created — so the rule that binds is
    // "what you return is what you SENT", and dropping the key would record
    // that cdkd sent nothing. The recorded shape is the CFn one
    // (`StreamViewType` only — `AWS::DynamoDB::GlobalTable`'s
    // `StreamSpecification` declares no `StreamEnabled`, verified against
    // aws-cdk-lib's `convertCfnGlobalTableStreamSpecificationPropertyToCloudFormation`),
    // so the effective bag is indistinguishable from what an ordinary
    // template-path create of the same table records.
    //
    // LIVE. `streamSpecSubstituted` can only be set when
    // `context.replayingState` is true, and the sole caller that sets that
    // flag is `rollback-executor/replay-reverse-replacement.ts`'s reverse-replacement arm — which
    // HONOURS `effectiveProperties` as of issue #1682 (PR #1696): the bag
    // handed to `create()` IS `previousState.properties`, so what this arm
    // returns replaces the record's `properties` wholesale. Before that the
    // arm rebuilt the record from `prev.properties` and every provider's
    // replay-CREATE substitution was announced into a void.
    //
    // Live-tested by `tests/integration/rollback-replay-effective-props`
    // (`StreamTable`, issue #1706): it pins the recorded CFn shape
    // `{ StreamViewType }` and a clean diff against the live table.
    let streamSpecSubstituted = false;
    try {
      // `replayWarn` (issue #1544): a state record written by an older
      // binary can carry `StreamSpecification: ''`, and on the rollback
      // executor's reverse-replacement replay the user cannot edit that
      // record — a hard refusal would leave the old table unrestorable. The
      // downgrade treats the malformed block as `{}` (stream enabled with
      // the NEW_AND_OLD_IMAGES default, exactly what an empty block means),
      // warns, and proceeds; template-path creates keep the refusal.
      // The wrapper preserves `replayWarn`'s gate exactly: with no replay
      // downgrade in effect the options bag stays EMPTY, so a template-path
      // create keeps the hard refusal rather than silently gaining one.
      //
      // "Do not infer the skip by wrapping `onUnusable`" (#1612) does not
      // bind here: that rule guards a callback SHARED by SKIP-class guards
      // and warn-and-DEFAULT reads, where a generic wrapper cannot tell the
      // two apart and would record a defaulted-but-APPLIED value as skipped.
      // This is one call site of known class — a `readConfigString`
      // warn-and-DEFAULT — and what it records is precisely the DEFAULT that
      // was applied, which is the outcome that rule wants.
      const replayDowngrade = replayWarn(log, context).onUnusable;
      streamViewType = readConfigString(
        streamSpecInput,
        'StreamViewType',
        'NEW_AND_OLD_IMAGES',
        'AWS::DynamoDB::GlobalTable StreamSpecification',
        replayDowngrade
          ? {
              onUnusable: (message) => {
                streamSpecSubstituted = true;
                replayDowngrade(message);
              },
            }
          : {}
      );
    } catch (error) {
      // A cdkd-authored refusal: masked, never stamped (`wrapMaskedAwsError`
      // is for relayed AWS text only).
      throw new ProvisioningError(
        log.mask(describeAwsFailure(error).detail),
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
    createParams.StreamSpecification = {
      StreamEnabled: true,
      StreamViewType: streamViewType,
    } as StreamSpecification;
    if (streamSpecSubstituted) {
      effectiveProperties = {
        ...(effectiveProperties ?? properties),
        StreamSpecification: { StreamViewType: streamViewType },
      };
    }
  } else if (needsStream) {
    // cdkd deliberately sends MORE than the template asked for: cross-region
    // replication requires a stream, so one is enabled even where the
    // template declares no `StreamSpecification` at all — the "arms that do
    // NOT log a refusal" case.
    //
    // Issue #1723: recorded, paired with the `canonicalizeDesiredProperties`
    // twin through the one shared predicate, so an unchanged template still
    // diffs NO_CHANGE. Not for phantom drift — there is none either way, the
    // drift walk descending only into keys a record has — but because a
    // record without the stream reads a template that LATER declares the
    // same `{ StreamViewType: NEW_AND_OLD_IMAGES }` as a change, and
    // `update()` then asks AWS to enable a stream the table already has.
    // Only the region-independent half is recorded; see the helper.
    const impliedStream = replicationImpliedStreamSpecification(properties);
    if (impliedStream) {
      effectiveProperties = {
        ...(effectiveProperties ?? properties),
        [STREAM_SPECIFICATION_KEY]: impliedStream,
      };
    }
    this.logger.info(
      log.mask(
        `Auto-enabling streams (NEW_AND_OLD_IMAGES) on ${logicalId} — required for cross-region replication`
      )
    );
    createParams.StreamSpecification = {
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    } as StreamSpecification;
  }

  // GSIs: the CFn GlobalTable GSI shape models throughput differently
  // from the SDK's `GlobalSecondaryIndex` (Issue #1387) — translate
  // rather than cast. Pre-fix a PROVISIONED GlobalTable with a GSI
  // failed `CreateTable` outright (AWS requires per-GSI
  // `ProvisionedThroughput`) and per-GSI on-demand limits were dropped.
  // Called UNCONDITIONALLY (it returns [] for an absent value): a truthiness
  // gate here would let `null` / `''` / `0` skip the helper's non-array guard
  // and deploy a zero-GSI table — the very case that guard exists for.
  // `create()` has no wrapping catch around this point, so the helper's plain
  // Error is converted to a ProvisioningError here rather than escaping
  // untyped into the deploy engine's retry loop.
  let sdkIndexes: GlobalSecondaryIndex[];
  let indexesOmitted = false;
  try {
    // The trailing `onUnusableIndexes` hook is the GSI guard's replay
    // downgrade (issue #1544): on a reverse-replacement replay a non-array
    // `GlobalSecondaryIndexes` recorded in state warns and the block is
    // OMITTED (zero indexes) instead of stranding the rollback; on a
    // template-path create the hook is `undefined` and the refusal stands.
    //
    // This arm DROPS the key from the effective bag (issue #1724), which is
    // the replay-CREATE+SKIP answer `.claude/rules/providers.md` prescribes:
    // the helper returns the well-defined EMPTY list, so `CreateTable` goes
    // out with NO indexes and nothing was applied — there is no value to
    // vouch for. It is deliberately NOT the SUBSTITUTE shape its two
    // siblings above take: those APPLY a default (a stream really is
    // created, the table really is PAY_PER_REQUEST), so what they record is
    // what they sent, whereas recording the malformed blob here would claim
    // indexes AWS does not hold — a record `readCurrentState` can never
    // match, which the NEXT update then reads as its previous side (the
    // #1552 class). Which arm you are on is a property of the GUARD, not of
    // the path: ask whether the call went out.
    const onUnusableCreateIndexes = replayWarn(log, context).onUnusable;
    sdkIndexes = toSdkGlobalSecondaryIndexes(
      properties,
      currentRegion,
      billingMode,
      'min',
      diagnostics,
      onUnusableCreateIndexes &&
        ((message) => {
          indexesOmitted = true;
          onUnusableCreateIndexes(
            `${message} Omitting the malformed block, so this create carries NO ` +
              `indexes; the same value is REFUSED on a template-path create`
          );
        }),
      maskSecrets
    );
  } catch (error) {
    // A cdkd-authored refusal: masked, never stamped (`wrapMaskedAwsError` is
    // for relayed AWS text only).
    throw new ProvisioningError(
      log.mask(describeAwsFailure(error).detail),
      resourceType,
      logicalId,
      undefined,
      error instanceof Error ? error : undefined
    );
  }
  // What the post-`CreateTable` wiring reads the replicas from. It differs
  // from `properties` only on the omit arm below, and it is ONE value so the
  // three consumers of a replica's index block — the pre-flight scan,
  // `addReplica`, and the autoscaling registration — cannot disagree about
  // whether that block still exists.
  let wiringProperties: Record<string, unknown> = properties;
  if (indexesOmitted) {
    // Composed onto whatever the earlier arms recorded (`?? properties`) —
    // a single state record can carry more than one malformed value, and
    // this is the LAST of the three arms.
    //
    // The top-level key is dropped, matching what was actually skipped.
    effectiveProperties = { ...(effectiveProperties ?? properties) };
    delete effectiveProperties['GlobalSecondaryIndexes'];
    // ...and EVERY replica's index block, local and cross-region alike
    // (issue #1741, second instance). Each one names indexes of THIS table,
    // and this create builds none, so none of them can be applied:
    //
    //  - the LOCAL block is only a CAPACITY SOURCE that
    //    `toSdkGlobalSecondaryIndexes` reads through `localByName`, and that
    //    call returned the EMPTY list;
    //  - a CROSS-REGION block has its own send path (`addReplica`, after
    //    `CreateTable`), but it is an OVERRIDE of an index the replica
    //    inherits from the source table, and there is no such index. Before
    //    this it was kept, sent AND recorded. Measured live on an on-demand
    //    read ceiling: AWS accepted the replica-add and the re-created
    //    replica held no override, so the record claimed a value AWS never
    //    applied. Live coverage: the opt-in cross-region arm of
    //    `tests/integration/rollback-replay-effective-props`.
    //
    // So the omit prunes everything downstream that referenced the indexes —
    // the same shape as the `AttributeDefinitions` prune below — on the WIRE
    // (`wiringProperties`) and in the RECORD alike. The RECORD half is the
    // one with a user-visible consequence: `readCurrentState` attaches a
    // replica's index block only when the live table has indexes, so on a
    // zero-index table a retained block is a never-matchable record, which
    // the next update reads as its previous side (the #1724 class). The WIRE
    // half keeps the two in agreement — the record describes what was sent —
    // and stops a request naming an index that does not exist.
    //
    // The block is withdrawn from each bag SEPARATELY: the record composes
    // onto the earlier arms' answer (the billing strip may already have
    // rewritten `Replicas`), while the wire reads the replay's own bag.
    const recorded = withdrawReplicaIndexBlocks(effectiveProperties['Replicas']);
    if (recorded.changed) effectiveProperties['Replicas'] = recorded.replicas;
    const wired = withdrawReplicaIndexBlocks(properties['Replicas']);
    if (wired.changed) {
      wiringProperties = { ...properties, Replicas: wired.replicas };
      // Announced from HERE rather than folded into the omit warning above:
      // that one fires from the GSI guard, which never reads a replica's
      // block, and a withdrawn cross-region override is a separate loss the
      // user would otherwise have no way to see. The local block needs no
      // line of its own — it only ever fed the translation that warning
      // already reports as empty.
      const crossRegion = wired.withdrawnRegions.filter((region) => region !== currentRegion);
      if (crossRegion.length > 0) {
        warn(
          `DynamoDB GlobalTable ${logicalId}: omitting the GlobalSecondaryIndexes ` +
            `overrides of replica(s) ${crossRegion.join(', ')}: they name indexes this ` +
            `create does not build, so there is nothing for them to apply to`
        );
      }
    }
    // ...and PRUNE `AttributeDefinitions` down to the attributes this call
    // still keys on (issue #1741). DynamoDB requires the definitions to be
    // EXACTLY the attributes referenced by `KeySchema` and by the indexes
    // being created, so omitting the indexes while sending their key
    // attributes leaves an orphan and AWS rejects the WHOLE call:
    //
    //   ValidationException: One or more parameter values were invalid: Some
    //   AttributeDefinitions are not used. AttributeDefinitions: [pk, gsipk],
    //   KeySchema: [pk]
    //
    // That is the ordinary shape — an index keyed on its own attribute — so
    // before this the downgrade FAILED on exactly the population it exists
    // for: a reverse-replacement rollback of a table whose state record an
    // older binary wrote badly did not re-create the table at all, and the
    // refusal it replaced at least failed before touching AWS.
    //
    // LSI key attributes MUST survive: `LocalSecondaryIndexes` is create-only
    // and is NOT omitted by this arm (it is sent from `properties` a few
    // lines below), so a naive "keep only the table KeySchema" would break a
    // table with an LSI — which is why the scope is passed explicitly rather
    // than defaulted.
    const keptKeyAttributes = collectDesiredKeyAttributeNames(properties, {
      indexListKeys: ['LocalSecondaryIndexes'],
    });
    // Fail OPEN on an unreadable key schema OR a non-array definitions bag.
    // An empty set means no key schema resolved to a name at all (an
    // intrinsic-valued `KeySchema`, a malformed block), and pruning against
    // it would strip EVERY definition and turn a template defect into a
    // different, more confusing AWS error. Leaving the definitions alone is
    // the pre-fix behavior, and AWS still rejects the genuinely-bad call
    // loudly.
    //
    // The `Array.isArray` half is not defensive padding: `attributeDefinitions`
    // is a bare cast guarded only by a truthiness test above, so a state
    // record carrying `{}` / a string / an unresolved intrinsic reaches here
    // — and this is the REPLAY path, where a malformed record IS the premise.
    // `.filter` on a non-array throws a raw `TypeError` outside any `try`,
    // which would escape untyped into the deploy engine instead of the
    // `ValidationException` AWS returns today.
    if (keptKeyAttributes.size > 0 && Array.isArray(attributeDefinitions)) {
      const prunedAttributeDefinitions = attributeDefinitions.filter((definition) => {
        const name = asRecord(definition)?.['AttributeName'];
        // An UNPARSEABLE entry is KEPT, not pruned. Only a definition whose
        // `AttributeName` cdkd can actually read is knowably orphaned;
        // dropping one it could not parse would be a silent loss decided on
        // the strength of a value that was never read — the class the
        // config-shape guards exist to refuse — and it would do so on the
        // replay path, where malformed records are the premise. Keeping it
        // reproduces the pre-fix behavior for that entry: AWS rejects the
        // call loudly and names the field.
        if (typeof name !== 'string') return true;
        return keptKeyAttributes.has(name);
      });
      if (prunedAttributeDefinitions.length !== attributeDefinitions.length) {
        createParams.AttributeDefinitions = prunedAttributeDefinitions;
        // Recorded for the same reason the index key itself is dropped: an
        // attribute definition that was not SENT is the phantom-drift class
        // (#1724), so the effective bag has to describe the pruned list.
        //
        // NO `canonicalizeDesiredProperties` twin, and the question is asked
        // here rather than inherited (the `.claude/rules/providers.md` rule
        // is to re-ask it at every recording site). The twin exists because a
        // narrowed record makes the next diff read the difference as a
        // user-made ADD, and for a CREATE-ONLY property that classifies as a
        // REPLACEMENT. Neither holds: `AWS::DynamoDB::GlobalTable` has no
        // `ReplacementRulesRegistry` entry and its schema's
        // `createOnlyProperties` is `TableName` alone, so the un-canonicalized
        // diff derives an IN-PLACE update — and that update genuinely
        // converges, because `update()` re-adds the definitions a restored
        // index needs. Canonicalizing instead would fold the template side
        // onto the pruned list and leave the re-created table permanently
        // missing the indexes the record was malformed about, which is the
        // opposite of the recovery this arm exists to enable.
        // A distinct array from the one on `createParams`, so a later mutation
        // of either cannot reach the other (the rollback executor spreads the
        // effective bag shallowly). Scoped to the PRUNED path deliberately:
        // on the untouched path both sides still alias the caller's
        // `properties['AttributeDefinitions']`, exactly as before this change.
        effectiveProperties['AttributeDefinitions'] = [...prunedAttributeDefinitions];
      }
    }
  }
  if (sdkIndexes.length > 0) {
    createParams.GlobalSecondaryIndexes = sdkIndexes;
  }
  if (properties['LocalSecondaryIndexes']) {
    createParams.LocalSecondaryIndexes = properties[
      'LocalSecondaryIndexes'
    ] as LocalSecondaryIndex[];
  }
  // go-to-k/cdkd#2762: vector indexes ride `CreateTable` (member names shared
  // with CFn, `Dimensions` on the Integer grammar). Every replica added below
  // inherits them (measured, us-east-1 + us-east-2, 2026-11-01).
  const createVectorIndexes = vectorIndexesForCreate(properties['VectorIndexes']);
  if (createVectorIndexes !== undefined) createParams.VectorIndexes = createVectorIndexes;
  // go-to-k/cdkd#2762: the table's warm throughput rides `CreateTable` too, on
  // either billing mode. An unusable block is reported below and not sent.
  const warmCoercion = coerceWarmThroughput(properties['WarmThroughput']);
  if (warmCoercion.spec) createParams.WarmThroughput = warmCoercion.spec;
  const warmDiagnostic = warmThroughputDiagnostic(
    properties['WarmThroughput'],
    warmCoercion,
    undefined
  );
  if (warmDiagnostic) diagnostics.push(warmDiagnostic);
  // go-to-k/cdkd#5489: the settings replication mode rides `CreateTable`, as
  // CloudFormation sends it; a mode on a table with more than one replica is
  // refused below (`replicaSettingsRefusal`) before anything is created.
  const createMode = readReplicationMode(properties);
  if (createMode.kind === 'usable') {
    createParams.GlobalTableSettingsReplicationMode =
      createMode.mode as GlobalTableSettingsReplicationMode;
  }

  // SSE: GlobalTable's CFn shape is { SSEEnabled, SSEType } with NO
  // top-level KMSMasterKeyId — the key is per-replica, so the LOCAL table's
  // comes from its own `Replicas[?Region==<deploy region>]` entry
  // (go-to-k/cdkd#5355; before it, a CMK table was created under the AWS
  // managed key).
  // An `SSEEnabled` that is not a boolean is refused rather than read: the
  // fallback below would ENABLE encryption for it. A replay of a state
  // record (which the user cannot edit) warns and takes that fallback.
  const sseEnabledRefusal = configBooleanRefusal(
    properties['SSESpecification'],
    'SSEEnabled',
    'AWS::DynamoDB::GlobalTable SSESpecification'
  );
  if (sseEnabledRefusal !== undefined) {
    const onReplay = replayWarn(log, context).onUnusable;
    if (!onReplay) {
      throw new ProvisioningError(
        log.mask(
          `AWS::DynamoDB::GlobalTable ${logicalId}: ${sseEnabledRefusal}. Nothing was created; ` +
            `fix the template value`
        ),
        resourceType,
        logicalId
      );
    }
    onReplay(`${sseEnabledRefusal}. Encryption is enabled, the block's default.`);
  }
  // go-to-k/cdkd#5365: the per-replica settings the wiring below sends, read
  // by the write plan's own readers, refused before anything is created. A
  // replay of a state record (which the user cannot edit) skips an
  // unreadable block with a warning instead, and tries a policy anyway.
  const replicaSettingRefusal = replicaSettingsRefusal(properties, undefined, currentRegion);
  if (replicaSettingRefusal !== undefined && !replayWarn(log, context).onUnusable) {
    throw new ProvisioningError(
      log.mask(
        `AWS::DynamoDB::GlobalTable ${logicalId}: ${replicaSettingRefusal}. Nothing was ` +
          `created; fix the template value`
      ),
      resourceType,
      logicalId
    );
  }
  if (properties['SSESpecification']) {
    createParams.SSESpecification = toSdkTableSseSpecification(
      properties['SSESpecification'],
      readReplicaKmsMasterKeyId(localReplicaEntry(properties, currentRegion))
    );
  }

  // DeletionProtectionEnabled is per-replica in the CFn schema for
  // `AWS::DynamoDB::GlobalTable` (just like Tags). CDK 2.x's
  // `deletionProtection: true` synthesizes to
  // `Replicas[?Region==<deploy region>].DeletionProtectionEnabled`.
  // Extract via the shared module-level helper.
  const dpeResolved = extractLocalDeletionProtection(properties, currentRegion);
  if (dpeResolved !== undefined) {
    createParams.DeletionProtectionEnabled = dpeResolved;
  }
  // Per-replica in the CFn schema too (`Replicas[].TableClass`, where CDK's
  // `tableClass` renders) — go-to-k/cdkd#5355.
  const localTableClass = extractLocalTableClass(properties, currentRegion);
  if (localTableClass !== undefined) {
    createParams.TableClass = localTableClass;
  }

  // Table-level on-demand ceilings. CDK's `Billing.onDemand({ maxRead…,
  // maxWrite… })` splits the pair across two CFn locations — the write half
  // at top-level `WriteOnDemandThroughputSettings`, the read half on the
  // LOCAL replica's `ReadOnDemandThroughputSettings` — and only the write
  // half was ever wired, so a user who capped read request units got a table
  // with NO read ceiling and a success report (issue #1436). Both halves go
  // into the SAME `CreateTable` member.
  const createCeilings = collectTableOnDemandCeilings(
    properties,
    currentRegion,
    diagnostics,
    maskSecrets
  );
  const createOnDemand: OnDemandThroughput = {
    ...(createCeilings.read.value !== undefined && {
      MaxReadRequestUnits: createCeilings.read.value,
    }),
    ...(createCeilings.write.value !== undefined && {
      MaxWriteRequestUnits: createCeilings.write.value,
    }),
  };
  if (billingMode !== 'PROVISIONED' && Object.keys(createOnDemand).length > 0) {
    createParams.OnDemandThroughput = createOnDemand;
  }

  // Tags are per-replica in the CFn `AWS::DynamoDB::GlobalTable`
  // schema (there is NO top-level `Properties.Tags` field — CDK's
  // `cdk.Tags.of(tableV2).add(...)` puts them in
  // `Replicas[?Region==<deploy region>].Tags`). For the LOCAL replica
  // we apply them via `CreateTable`'s top-level `Tags` field (avoids
  // a separate `TagResource` round-trip). Cross-region replicas'
  // Tags are propagated AFTER the replicas flip ACTIVE — see the
  // `applyCrossRegionReplicaTagsDiff` loop further down (Issue #441).
  const localReplicaForTags = replicas.find((r) => r['Region'] === currentRegion);
  const localReplicaTags =
    localReplicaForTags !== undefined ? desiredReplicaTags.get(localReplicaForTags) : undefined;
  if (localReplicaTags && localReplicaTags.length > 0) {
    createParams.Tags = localReplicaTags.map((t): Tag => ({ Key: t.Key, Value: t.Value }));
  }

  // Pre-flight the CROSS-REGION replica blocks through the same translators
  // the post-`CreateTable` wiring will use, discarding the result and
  // keeping only the diagnostics. Issue #1428's third rejected design
  // surfaced its complaint from inside that wiring, which meant a
  // statically-detectable garbage value created a real table first — and
  // under `DeletionProtectionEnabled: true` the compensating delete fails,
  // orphaning a billing table with no state record. Reporting is cheap and
  // pure, so it happens BEFORE the first mutating call instead.
  //
  // Both this scan and the replica-add loop below read `wiringReplicas`, so
  // a block the omit arm withdrew is neither reported nor sent.
  const wiringReplicas =
    (wiringProperties['Replicas'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const replica of wiringReplicas) {
    const replicaRegion = replica['Region'] as string | undefined;
    if (!replicaRegion || replicaRegion === currentRegion) continue;
    toSdkReplicaGlobalSecondaryIndexes(
      replica['GlobalSecondaryIndexes'],
      billingMode,
      diagnostics,
      maskSecrets
    );
    toSdkReplicaThroughputOverrides(replica, billingMode, diagnostics, {}, maskSecrets);
  }
  this.reportThroughputDiagnostics(diagnostics, logicalId, tableName, maskSecrets);

  // go-to-k/cdkd#5615: the targets a failed create has to take down itself.
  let registeredBeforeReplicas: AutoScalingTargetSpec[] = [];

  // go-to-k/cdkd#4606: the `TableId` CreateTable answered with, carried on
  // the created-before-failure mark so the journal needs no read of a table
  // whose failure (a describe that cannot run, say) may fail that read too.
  let createdTableId: string | undefined;
  try {
    const createOut = await (
      await this.getCreateClient()
    ).send(new CreateTableCommand(createParams));
    // An absent or empty id is dropped by `markCreatedBeforeFailure`.
    createdTableId = createOut?.TableDescription?.TableId;
    // go-to-k/cdkd#5511: report before the ACTIVE wait.
    reportCreatedResource(logicalId, resourceType, tableName, createdTableId);
    log.debug(`CreateTable initiated for ${log.value(tableName)}, waiting for ACTIVE`);
  } catch (error) {
    // CreateTable itself failed: no table this create can attribute to
    // itself, so no cleanup. A 5xx may hide a committed one; the engine's
    // retry then reads its collision as possibly replayed (#4639).
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create DynamoDB GlobalTable ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          tableName,
          cause
        )
    );
  }

  return createPhaseCommit.call(this, {
    tableName,
    logicalId,
    maskSecrets,
    createVectorIndexes,
    billingMode,
    wiringProperties,
    currentRegion,
    wiringReplicas,
    registeredBeforeReplicas,
    replicas,
    desiredReplicaTags,
    resourceType,
    log,
    context,
    warn,
    properties,
    effectiveProperties,
    createdTableId,
  });
}
