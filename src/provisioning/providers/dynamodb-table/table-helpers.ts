import type { CreateTableCommandInput, SSEDescription } from '@aws-sdk/client-dynamodb';
import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configIntegerRefusal,
} from '../../config-shape.js';
import { INDEX_SETTLE_POLL_INTERVAL_MS } from '../../dynamodb-index-busy-delete.js';
import { TABLE_GONE_WAIT_ATTEMPTS } from '../dynamodb-globaltable-provider.js';
import { DYNAMODB_DELETE_POLL_COST_MS } from '../dynamodb-delete-budget.js';
import { maskDeep } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';

/**
 * A DynamoDB table NAME (3-255 of `a-z A-Z 0-9 _ . -`), the physical id this
 * provider records. The identity answers (`isSameResource`,
 * `resourceIdentity`) refuse anything else: `DescribeTable` also takes a
 * table ARN, which this provider never records and would only be guessing
 * about.
 */
export function isTableName(id: string): boolean {
  return /^[A-Za-z0-9_.-]{3,255}$/.test(id);
}

/**
 * AWS DynamoDB Table Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::Table using the DynamoDB SDK.
 * WHY: The CC API polls for DynamoDB table creation with exponential backoff
 * (1s->2s->4s->8s->10s), but we can poll DescribeTable directly with shorter
 * intervals, eliminating the CC API intermediary overhead and reducing total
 * wait time.
 */
/**
 * Map CloudFormation's `SSESpecification` shape to the DynamoDB SDK's.
 *
 * The CFn property names the enable flag `SSEEnabled`, but the SDK
 * `CreateTableCommandInput.SSESpecification` field is `Enabled`. Passing the
 * CFn shape verbatim makes the SDK silently ignore the unknown `SSEEnabled`
 * key, so the table is created with AWS-owned (default) encryption instead of
 * the requested AWS-managed / customer-managed KMS encryption — a silent
 * security downgrade with no error. `SSEType` and `KMSMasterKeyId` keep the
 * same names across CFn and the SDK.
 *
 * Returns `undefined` for an absent / non-object value so the caller omits the
 * field entirely. Exported for unit testing.
 */
export function mapSSESpecification(
  raw: unknown
): CreateTableCommandInput['SSESpecification'] | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const cfn = raw as { SSEEnabled?: unknown; SSEType?: unknown; KMSMasterKeyId?: unknown };
  const out: NonNullable<CreateTableCommandInput['SSESpecification']> = {};
  if (cfn.SSEEnabled !== undefined) {
    // CDK synthesizes a real boolean, but tolerate the stringified form.
    out.Enabled = coerceCfnBoolean(cfn.SSEEnabled) === true;
  }
  if (typeof cfn.SSEType === 'string') {
    out.SSEType = cfn.SSEType as NonNullable<
      CreateTableCommandInput['SSESpecification']
    >['SSEType'];
  }
  if (typeof cfn.KMSMasterKeyId === 'string') {
    out.KMSMasterKeyId = cfn.KMSMasterKeyId;
  }
  return out;
}

/**
 * The refusal sentence for an unusable CFn `SSESpecification` (go-to-k/cdkd#5412):
 * an `SSEEnabled` that is no boolean, a block that is no object, or a declared
 * `null` (which `configBooleanRefusal` treats as absent, and an absent block
 * is a removal; CloudFormation rejects `null`). One predicate for `create()`
 * and `update()`, so the two cannot disagree on a value.
 */
export function sseSpecificationRefusal(value: unknown, logicalId: string): string | undefined {
  const path = `AWS::DynamoDB::Table ${logicalId} SSESpecification`;
  if (value === null) return `${path} must be an object (got null)`;
  return configBooleanRefusal(value, 'SSEEnabled', path);
}

/**
 * The SDK `SSESpecification` an update sends for a changed CFn
 * `SSESpecification` (go-to-k/cdkd#5412), or `undefined` for none:
 *
 * - a declared block is mapped by {@link mapSSESpecification}. The caller
 *   refuses one `configBooleanRefusal` refuses first (a redacted `***` or an
 *   unresolved `{{resolve:` `SSEEnabled` would read as `false` and reset the
 *   table's key);
 * - a REMOVED block resets the table to the AWS owned key with
 *   `{ Enabled: false }`, which is what CloudFormation does. As the
 *   GlobalTable twin's removal arm (go-to-k/cdkd#5355), it is sent only when
 *   encryption was on: by the LIVE `SSEDescription` when it reports a status,
 *   else by the previous block's `SSEEnabled`, so a previous value that is no
 *   boolean sends nothing.
 *
 * `{ Enabled: false }` is never sent to a table AWS reports on the AWS owned
 * key already (`SSEDescription` absent, or `DISABLED` / `DISABLING`), nor a
 * declared key ARN AWS already reports `ENABLED`: there is nothing to change.
 * A declared `null` is not a removal and sends nothing (the caller refuses it).
 * Exported for unit testing.
 */
export function sseSpecificationToSend(
  desired: unknown,
  previous: unknown,
  liveSse: SSEDescription | undefined,
  described: boolean
): CreateTableCommandInput['SSESpecification'] | undefined {
  const status = liveSse?.Status;
  const liveOn = status === 'ENABLED' || status === 'ENABLING' || status === 'UPDATING';
  const liveOff =
    described && (liveSse === undefined || status === 'DISABLED' || status === 'DISABLING');
  if (desired !== undefined) {
    // A declared `null` maps to nothing: only an ABSENT block is a removal.
    const mapped = mapSSESpecification(desired);
    if (mapped === undefined || Object.keys(mapped).length === 0) return undefined;
    if (mapped.Enabled === false && liveOff) return undefined;
    // The same key AWS already reports needs no call (a rollback revert after
    // a forward update failed before its SSE call). AWS reports a key ARN, so
    // a declared key ARN or bare key id compares; an alias would need a KMS
    // call to resolve and is sent as before.
    const liveKeyArn = liveSse?.KMSMasterKeyArn;
    if (
      mapped.Enabled === true &&
      status === 'ENABLED' &&
      mapped.KMSMasterKeyId !== undefined &&
      liveKeyArn?.includes(':key/') === true &&
      (mapped.KMSMasterKeyId === liveKeyArn ||
        mapped.KMSMasterKeyId === liveKeyArn.slice(liveKeyArn.lastIndexOf(':key/') + 5)) &&
      (mapped.SSEType === undefined || mapped.SSEType === liveSse?.SSEType)
    ) {
      return undefined;
    }
    return mapped;
  }
  if (liveOff) return undefined;
  const previousOn =
    previous !== null && typeof previous === 'object'
      ? coerceCfnBoolean((previous as Record<string, unknown>)['SSEEnabled']) === true
      : false;
  return liveOn || previousOn ? { Enabled: false } : undefined;
}

/**
 * Read one capacity member out of a per-index `ProvisionedThroughput` block,
 * returning `undefined` for anything that is not a usable number.
 *
 * Deliberately has NO default (issue #1588 review). The BillingMode-flip caller
 * suppresses the per-index update path for every index it handles, so a
 * defaulted capacity would never be corrected by a later call and would land in
 * cdkd state as if the template had declared it. Returning `undefined` routes
 * the index to the same warn-and-omit path an absent block takes, letting AWS
 * name it — the CFn-handler outcome.
 *
 * CFn is stringly typed, so a numeric string is accepted and coerced — through
 * {@link coerceCfnInteger}, CloudFormation's MEASURED DynamoDB Integer grammar
 * (issue [#3147](https://github.com/go-to-k/cdkd/issues/3147); the table is on
 * `toCfnInteger` in `../dynamodb-warm-throughput.ts`): an optional sign and
 * decimal digits, with NO trim, so `" 7 "` / `"7 "` / `""` / `"0x9"` / `"1e1"`
 * / `"6.5"` are every one `undefined` here because CloudFormation refuses the
 * template that spells them. The pre-#3147 reader was `Number()`, which
 * forwarded `7` / `9` / `10` for the first four and deployed an index at a
 * capacity CloudFormation would not have accepted. `NaN` / `Infinity` / a
 * non-integer number / objects / unresolved intrinsics were never usable and
 * still are not.
 */
export function readCapacityNumber(block: unknown, member: string): number | undefined {
  if (!isPlainCapacityBlock(block)) return undefined;
  return coerceCfnInteger(block[member]);
}

/**
 * The template-path refusal for `PointInTimeRecoverySpecification` (issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255)), run by `create()` and
 * `update()` before their first AWS call.
 *
 * A `RecoveryPeriodInDays` spelling CloudFormation rejects used to be DROPPED
 * and announced, so `UpdateContinuousBackups` SUCCEEDED at DynamoDB's default
 * period while the state record kept the declared value: `readCurrentState`
 * reads the default back, and every drift run reported a difference that
 * `drift --revert` re-sent forever. Refusing it instead keeps cdkd at
 * CloudFormation parity — the AWS CDK CLI cannot deploy this template either —
 * and leaves nothing recorded to drift against.
 *
 * The FIELD half is {@link coerceCfnInteger}, the function the applier reads
 * the member with, so the two cannot disagree on a spelling. The range is the
 * API's documented 1-35, which `UpdateContinuousBackups` rejects outside of:
 * refused here, a create no longer makes the table only to delete it again.
 * A non-object block is refused by the CONTAINER half — the applier read one
 * as "PITR disabled". The message names shapes only, never the value.
 */
export function pointInTimeRecoveryRefusal(spec: unknown): string | undefined {
  return configIntegerRefusal(
    spec,
    'RecoveryPeriodInDays',
    'AWS::DynamoDB::Table PointInTimeRecoverySpecification',
    1,
    35
  );
}

/**
 * Is this a `ProvisionedThroughput` block whose MEMBERS can be read at all?
 *
 * One spelling, shared by {@link readCapacityNumber} — where a `false` answer
 * means "no usable member" — and by
 * {@link DynamoDBTableProvider.coerceIndexCapacityBlock}, where it means
 * "forward this VERBATIM and let AWS name the shape" (issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255)). The two conclusions
 * differ; the shape test must not, or the create forwarder could rewrite a
 * block the flip's reader refuses to read (or vice versa).
 *
 * An ARRAY is excluded deliberately: `[]` indexes to `undefined` for both
 * members, so treating it as a block would DROP nothing and report nothing
 * while `CreateTable` rejects the list by name anyway.
 */
export function isPlainCapacityBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a desired `GlobalSecondaryIndexes[]` entry declares BOTH capacity
 * members usably — the same test the BillingMode flip's per-index block applies
 * before it forwards the index, expressed as a predicate for the pre-flip
 * removal's look-ahead (issue #1617).
 *
 * BOTH members are required, exactly as in the flip block: an entry declaring
 * only one is treated like an absent one there, so accepting it here would let
 * the pre-flip delete run ahead of a flip AWS still rejects.
 *
 * A MIRROR, so it calls {@link readCapacityNumber} — the function the flip's
 * per-index forwarder calls — rather than restating the rule. That is what kept
 * it correct across issue [#3147](https://github.com/go-to-k/cdkd/issues/3147):
 * the reader moved to CloudFormation's Integer grammar and this predicate moved
 * with it, so a padded `" 7 "` is "no usable declared capacity" here exactly
 * because the forwarder drops it there.
 */
export function hasUsableDeclaredCapacity(entry: Record<string, unknown> | undefined): boolean {
  const declared = entry?.['ProvisionedThroughput'];
  return (
    readCapacityNumber(declared, 'ReadCapacityUnits') !== undefined &&
    readCapacityNumber(declared, 'WriteCapacityUnits') !== undefined
  );
}

/**
 * `DescribeTable` poll budget (seconds, 1 poll/s) after an ordinary
 * `UpdateTable` — capacity, TTL, tags, table class. Calibrated on those and
 * sufficient for them.
 */
// EXPORTED so the index-busy budget fence can read the real cap instead of
// copying it: this wait runs BEFORE that loop inside the same per-resource
// deadline, so it is a term of that arithmetic, and a copied 60 went on
// passing when the real cap was mutated to 900 (~18 min added to a 30-min
// deadline).
export const TABLE_ACTIVE_WAIT_ATTEMPTS = 60;

/**
 * The same budget for a BillingMode FLIP, which DynamoDB settles on a
 * different order of magnitude (measured 2026-08-11: a PAY_PER_REQUEST ->
 * PROVISIONED flip exceeded 60s and failed the deploy). Kept SEPARATE so a
 * genuinely wedged capacity edit still fails in a minute rather than ten.
 */
export const BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS = 600;

/**
 * Polls (x {@link KINESIS_DESTINATION_SETTLE_POLL_MS}) a Kinesis streaming
 * destination gets to settle after an `ApproximateCreationDateTimePrecision`
 * update (go-to-k/cdkd#5385). The update held the destination in `UPDATING`
 * for about 3.5 minutes (measured us-east-1, 2026-10-27), and
 * CloudFormation's own update of that member took about 2.5; 10 minutes
 * leaves room without hiding a wedged destination for long.
 *
 * The wait BEFORE the update only covers a destination an earlier deploy left
 * `ENABLING` / `UPDATING`, so it gets half that. Together the two can reach
 * 15 minutes per update, and both stop at the enclosing per-resource
 * deadline, which a billing-mode flip or GSI waits on the same update share.
 */
export const KINESIS_DESTINATION_SETTLE_POLLS = 300;

export const KINESIS_DESTINATION_PRE_UPDATE_POLLS = 150;

export const KINESIS_DESTINATION_SETTLE_POLL_MS = 2000;

/**
 * Polls after an update during which an `ACTIVE` destination still at the OLD
 * precision reads as "not started yet" rather than as a failure: the update
 * answered `UPDATING`, and a read right after a write can lag it.
 */
export const KINESIS_PRECISION_STALE_READ_GRACE_POLLS = 5;

/**
 * Re-reads (x {@link KINESIS_DISABLE_SETTLE_POLL_MS}) after
 * `DisableKinesisStreamingDestination` until the destination reads `DISABLED`
 * or absent (go-to-k/cdkd#5423). The disable answered `DISABLING`, yet
 * `DescribeKinesisStreamingDestination` read `ACTIVE` at about 1 s and
 * `DISABLED` at about 2.5 s (measured us-east-1, 2026-10-28), so a short
 * cadence keeps the wait near that; 60 s bounds a destination that never
 * settles, after which the deploy goes on with a warning.
 */
export const KINESIS_DISABLE_SETTLE_POLLS = 120;

export const KINESIS_DISABLE_SETTLE_POLL_MS = 500;

/**
 * The statuses a disabled destination may still read as: what
 * `readKinesisStreamSpecification` reports as present, plus `DISABLING`.
 */
export const KINESIS_DISABLE_PENDING_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'ENABLING',
  'UPDATING',
  'DISABLING',
]);

/**
 * Test seam for the index-busy `DeleteTable` retry's backoff (issue #1931),
 * mirroring the sibling provider's export of the same name. Production leaves
 * `sleep` undefined so `withRetry`'s real schedule applies; a test injects a
 * no-op so the ~95s of backoff at this type's budget
 * (`TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`) does not have to be waited out.
 *
 * One seam PER PROVIDER rather than one on the shared module: a `Table` test
 * that silences this backoff must not also silence the `GlobalTable` one, since
 * the two suites run in the same worker and a suite that stopped paying a delay
 * it meant to exercise fails silently — it just gets faster.
 */
export const deleteTableRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Mask every string LEAF (and every KEY) of a value before it is stringified
 * into a log line (issue #1932 item 3, adopted here by issue #1997).
 *
 * This is the INNER of the two masking layers `SecretMaskingContext` prescribes,
 * and neither layer subsumes the other. The outer one — routing the assembled
 * message through the masker — can only reach `maskSecretsInText`'s SUBSTRING
 * arm, which ignores needles below `MIN_NEEDLE_LENGTH` (4) and, more
 * importantly, never matches at all once `JSON.stringify` has escaped a `"`, a
 * `\` or a newline inside the value: the secret no longer OCCURS in the finished
 * line. Handing the masker each raw string reaches the WHOLE-VALUE arm at any
 * length and runs BEFORE any escaping. The mask is idempotent and matches by
 * value rather than by position, so applying both composes.
 *
 * Walks rather than testing the top level, because a secret nested in an object
 * leaf is stringified — and escaped — identically.
 */
export function maskLeafValue(value: unknown, maskSecrets: SecretMasker): unknown {
  // Issue #2176: delegates to the shared walk. This was one of SIX hand-rolled
  // copies and one of the FOUR that carried no depth cap. Kept as a named
  // wrapper only so this file's many call sites keep reading as
  // `maskLeafValue(...)`; the signature is identical to `maskDeep`'s.
  return maskDeep(value, maskSecrets);
}

/**
 * go-to-k/cdkd#5131: {@link DynamoDBTableProvider.waitForNameReleased}'s
 * bound -- the GlobalTable gone-wait's poll count and interval
 * (`TABLE_GONE_WAIT_ATTEMPTS`, `INDEX_SETTLE_POLL_INTERVAL_MS`). Mutable for
 * tests only.
 */
export const tableNameReleaseWait = {
  maxPolls: TABLE_GONE_WAIT_ATTEMPTS,
  intervalMs: INDEX_SETTLE_POLL_INTERVAL_MS,
};

/**
 * go-to-k/cdkd#5514: the post-delete gone-wait `delete()` runs once AWS has
 * accepted `DeleteTable` -- the GlobalTable gone-wait's cap
 * (`TABLE_GONE_WAIT_ATTEMPTS` polls at their measured cost, ~12 min) and
 * interval. The shared delete budget clamps it further. Mutable for tests
 * only.
 */
export const tableDeleteGoneWait = {
  maxWaitMs: TABLE_GONE_WAIT_ATTEMPTS * DYNAMODB_DELETE_POLL_COST_MS,
  pollIntervalMs: INDEX_SETTLE_POLL_INTERVAL_MS,
};
