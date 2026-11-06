import {
  DescribeTimeToLiveCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  type PointInTimeRecoverySpecification,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import { coerceCfnInteger } from '../../config-shape.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { SecretMasker } from '../../../types/resource.js';
import {
  isTtlAlreadyDisabled,
  isTtlRateLimited,
  planTimeToLive,
  readTtlSpec,
  sendTtlWaitingOutRateLimit,
} from '../../dynamodb-ttl.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { maskLeafValue } from './table-helpers.js';

/**
 * Apply a diff between old and new CFn-shape Tags arrays via DynamoDB's
 * `TagResource` / `UntagResource` APIs. Both take the table ARN as
 * `ResourceArn`. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: DynamoDBTableProvider,
  tableArn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  unsettled: {
    forceUpsert: boolean;
    beforeWrite: () => void;
    // go-to-k/cdkd#5498: the tag keys an accepted TagResource added that the
    // record lacked (never before the call; a call that throws added nothing).
    afterAdded?: (keys: string[]) => void;
  } = {
    forceUpsert: false,
    beforeWrite: () => undefined,
  }
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  // go-to-k/cdkd#5487: unsettled Tags re-send every template tag and remove
  // only the recorded ones the template dropped.
  const toSet = unsettled.forceUpsert ? planTagDiff(undefined, newTagsRaw).set : plan.set;
  const tagsToAdd = [...toSet].map(([k, v]) => ({ Key: k, Value: v }));
  const tagsToRemove = plan.remove;
  if (tagsToRemove.length > 0 || tagsToAdd.length > 0) unsettled.beforeWrite();

  if (tagsToRemove.length > 0) {
    await this.dynamoDBClient.send(
      new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove })
    );
    this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from DynamoDB table ${tableArn}`);
  }
  if (tagsToAdd.length > 0) {
    await this.dynamoDBClient.send(
      new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd })
    );
    // A malformed recorded tag list cannot say which keys are new: record none
    // (a missing name only keeps a tag, never removes one).
    let recordedKeys: Set<string> | undefined;
    try {
      recordedKeys = new Set([...planTagDiff(undefined, oldTagsRaw).set.keys()]);
    } catch {
      recordedKeys = undefined;
    }
    unsettled.afterAdded?.(
      tagsToAdd
        .map((t) => t.Key)
        .filter((key) => recordedKeys !== undefined && !recordedKeys.has(key))
    );
    this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on DynamoDB table ${tableArn}`);
  }
}

/**
 * Apply the table's `PointInTimeRecoverySpecification` via the separate
 * `UpdateContinuousBackups` API (PITR does NOT ride on CreateTable).
 *
 * CFn shape is `{ PointInTimeRecoveryEnabled: boolean, RecoveryPeriodInDays?: number }`.
 * Called from both `create()` (after the table is ACTIVE) and `update()`
 * (only when the value changed). On `update()`-side removal — when the
 * template drops the block but it was present before — we explicitly
 * disable PITR (`UpdateContinuousBackups` treats an absent spec as "no
 * change", so a dropped block must be turned into an explicit
 * `PointInTimeRecoveryEnabled: false`).
 */
export async function applyPointInTimeRecovery(
  this: DynamoDBTableProvider,
  tableName: string,
  spec: unknown,
  // REQUIRED rather than optional (issue
  // [#3364](https://github.com/go-to-k/cdkd/issues/3364)) — not a decision of
  // its own, but the consequence of making `maskSecrets` required: a required
  // parameter cannot follow an optional one. Both call sites already pass it
  // explicitly (`undefined` on the create path), so nothing changed but the
  // fence.
  previousSpec: unknown,
  // Threaded for the ONE warning below (issue #3147). The spec arrives
  // RESOLVED, so a member of it can be secret plaintext.
  //
  // REQUIRED, with no identity default (issue #3364): an omitted argument
  // would silently degrade BOTH masking layers at once, and the typechecker
  // is the only fence that catches it at every present and future call site.
  maskSecrets: SecretMasker
): Promise<void> {
  let enabled: boolean | undefined;
  let recoveryPeriodInDays: number | undefined;
  if (spec !== undefined && spec !== null) {
    const s = spec as Record<string, unknown>;
    enabled = Boolean(s['PointInTimeRecoveryEnabled']);
    // RecoveryPeriodInDays only applies when PITR is enabled; AWS rejects it
    // alongside PointInTimeRecoveryEnabled: false.
    if (enabled && s['RecoveryPeriodInDays'] !== undefined) {
      // `coerceCfnInteger`, CloudFormation's MEASURED DynamoDB Integer
      // grammar (issue #3147), not `Number()`. This is a FORWARDER — the
      // value rides `UpdateContinuousBackups` — and `Number()` sent a
      // padded `" 7 "` / `"0x9"` / `"1e1"` as 7 / 9 / 10 on a template
      // CloudFormation refuses, and a non-numeric one as **NaN**, which the
      // SDK serializes and AWS rejects with a message naming neither cdkd
      // nor the property.
      //
      // A template-borne value this rejects never gets here: `create()` and
      // `update()` refuse it before their first call (issue #3255,
      // `pointInTimeRecoveryRefusal`). What remains is a STATE-borne bag
      // (the rollback executor's replay arms, `drift --revert`), where a
      // refusal would leave the table un-rollbackable with no template-side
      // remedy, so the member is DROPPED and announced instead —
      // `UpdateContinuousBackups` goes out carrying only
      // `PointInTimeRecoveryEnabled`, i.e. PITR is enabled at DynamoDB's own
      // default period.
      const rawRecoveryPeriod = s['RecoveryPeriodInDays'];
      recoveryPeriodInDays = coerceCfnInteger(rawRecoveryPeriod);
      if (recoveryPeriodInDays === undefined) {
        // ONE masked sink (issue #1997), with the raw member masked leaf by
        // leaf before `JSON.stringify` can escape it past the mask.
        const warn = (message: string): void => this.logger.warn(maskSecrets(message));
        warn(
          `DynamoDB table ${tableName}: PointInTimeRecoverySpecification.RecoveryPeriodInDays ` +
            `${JSON.stringify(maskLeafValue(rawRecoveryPeriod, maskSecrets))} is not an Integer ` +
            `CloudFormation accepts (an optional sign and decimal digits only — no surrounding ` +
            `whitespace, hex, exponent or decimal point), so it was DROPPED from the ` +
            `UpdateContinuousBackups request: point-in-time recovery is enabled with DynamoDB's ` +
            `default recovery period instead of the declared one. Check for an unresolved ` +
            `intrinsic, or spell the value as a decimal integer.`
        );
      }
    }
  } else if (previousSpec !== undefined && previousSpec !== null) {
    // Removed from the template: disable.
    enabled = false;
  }

  if (enabled === undefined) return;

  const pitrSpec: PointInTimeRecoverySpecification = { PointInTimeRecoveryEnabled: enabled };
  if (recoveryPeriodInDays !== undefined) {
    pitrSpec.RecoveryPeriodInDays = recoveryPeriodInDays;
  }

  await this.retryOnTransientControlPlane(
    () =>
      this.dynamoDBClient.send(
        new UpdateContinuousBackupsCommand({
          TableName: tableName,
          PointInTimeRecoverySpecification: pitrSpec,
        })
      ),
    `enable PITR on ${tableName}`
  );
  this.logger.debug(
    `Set PointInTimeRecoveryEnabled=${enabled}${
      recoveryPeriodInDays !== undefined ? ` RecoveryPeriodInDays=${recoveryPeriodInDays}` : ''
    } on DynamoDB table ${tableName}`
  );
}

/**
 * Retry a DynamoDB control-plane call on the transient "settling" errors AWS
 * returns when two table-modifying operations land back-to-back. Enabling
 * PITR (`UpdateContinuousBackups`) puts the table in a transient state, and a
 * subsequent `UpdateTimeToLive` is then rejected with "Backups are being
 * enabled for the table ... Please retry later". `ResourceInUseException`
 * ("table is being updated") and `LimitExceededException` are the same class.
 * Backoff: ~2s,4s,8s,16s,30s,30s... bounded to ~2min total, which comfortably
 * covers the few-second PITR-enable window.
 */
export async function retryOnTransientControlPlane<T>(
  this: DynamoDBTableProvider,
  op: () => Promise<T>,
  label: string,
  maxAttempts = 8,
  options: {
    // One more transient class, for a caller that knows its target was
    // minted a moment ago (the stream arn of issue #3458).
    alsoTransient?: (error: unknown) => boolean;
    // Masks the retry line, whose AWS message can quote the target's arn —
    // and with it the table name, a RESOLVED template value.
    maskSecrets?: SecretMasker;
    // Send no retry once the enclosing resource deadline has run out: the
    // resource is already reported failed, and a mutation landing after
    // that (a TTL enable after the rollback's disable, #5451) leaves AWS
    // disagreeing with state. The last failure is rethrown instead.
    stopAtDeadline?: boolean;
  } = {}
): Promise<T> {
  let delayMs = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      // `.detail`, never `.summary`: the classifier below matches AWS's OWN
      // wording, which `.summary` replaces with the wire name alone. Same text as
      // the `instanceof Error ?` ternary it replaced, minus that ternary's throw.
      const msg = describeAwsFailure(error).detail;
      const name = error instanceof Error ? error.name : '';
      const transient =
        /being enabled|being updated|please retry later|backups are being/i.test(msg) ||
        name === 'ResourceInUseException' ||
        name === 'LimitExceededException' ||
        options.alsoTransient?.(error) === true;
      if (!transient || attempt >= maxAttempts) throw error;
      const retryLine = `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`;
      this.logger.debug(options.maskSecrets ? options.maskSecrets(retryLine) : retryLine);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (options.stopAtDeadline && enclosingDeadlineRemainingMs() <= 0) throw error;
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
}

/**
 * Pre-emptively reject a TTL `AttributeName` change between two enabled
 * specs with a clear, actionable message.
 *
 * AWS allows TTL on only ONE attribute per table, so enabling TTL on a new
 * attribute while TTL is still active on the old one fails with the opaque
 * `TimeToLive is active on a different AttributeName: <old>`; and because
 * DynamoDB rate-limits `UpdateTimeToLive` to one modification per table per
 * ~1 hour, the user cannot disable-then-re-enable within a single deploy
 * either. CloudFormation hits the same wall (UPDATE_ROLLBACK). Surfacing the
 * two-deploy remediation up front beats letting the raw AWS error bubble.
 *
 * Only fires when BOTH the old and new specs are present and enabled with a
 * DIFFERENT `AttributeName`. Enable-from-disabled, disable, and same-name
 * Enabled toggles all pass through to {@link applyTimeToLive}.
 */
export function assertNoActiveTtlAttributeNameChange(
  this: DynamoDBTableProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  spec: unknown,
  previousSpec: unknown
): void {
  const cur = readTtlSpec(spec);
  const prev = readTtlSpec(previousSpec);
  if (
    cur.enabled &&
    prev.enabled &&
    cur.attributeName !== undefined &&
    prev.attributeName !== undefined &&
    cur.attributeName !== prev.attributeName
  ) {
    throw new ProvisioningError(
      `DynamoDB table ${logicalId}: cannot change the TimeToLive AttributeName ` +
        `from '${prev.attributeName}' to '${cur.attributeName}' in a single deploy. ` +
        `AWS allows TTL on only one attribute and rejects enabling it on a new ` +
        `attribute while TTL is still active on '${prev.attributeName}' ` +
        `("TimeToLive is active on a different AttributeName"); DynamoDB also limits ` +
        `UpdateTimeToLive to one change per table per ~1 hour. To change the TTL ` +
        `attribute, do it in two deploys: (1) remove TimeToLiveSpecification (or set ` +
        `Enabled: false) to disable TTL on '${prev.attributeName}', then (2) after the ` +
        `disable settles (~1h), deploy again enabling TTL on '${cur.attributeName}'.`,
      resourceType,
      logicalId,
      physicalId
    );
  }
}

/**
 * Send the `UpdateTimeToLive` call {@link planTimeToLive} plans for a
 * `TimeToLiveSpecification` change (issue #5447): `Enabled: false` without
 * an `AttributeName` disables TTL on the recorded attribute, or on the one
 * `DescribeTimeToLive` reports when no enabled spec was recorded; a
 * disabled spec on a new or already-disabled table sends nothing, since AWS
 * refuses to disable a TTL that is not enabled.
 *
 * AWS also refuses a second `UpdateTimeToLive` for a while after the last
 * one; like CloudFormation, the call is re-sent until AWS accepts it, within
 * the resource timeout (#5451). A refusal still standing when that runs out
 * is rethrown as a cdkd-authored error, since the AWS text itself is
 * redacted from the thrown message.
 */
export async function applyTimeToLive(
  this: DynamoDBTableProvider,
  tableName: string,
  spec: unknown,
  previousSpec: unknown,
  mode: 'create' | 'update',
  ids: { logicalId: string; resourceType: string; maskSecrets: SecretMasker }
): Promise<void> {
  const plan = planTimeToLive(spec, previousSpec, mode);
  let enabled: boolean;
  let attributeName: string;
  if (plan.kind === 'none') return;
  if (plan.kind === 'disable-live') {
    const resp = await this.retryOnTransientControlPlane(
      () => this.dynamoDBClient.send(new DescribeTimeToLiveCommand({ TableName: tableName })),
      `read TTL on ${tableName}`,
      undefined,
      { maskSecrets: ids.maskSecrets }
    );
    const live = resp.TimeToLiveDescription;
    const status = live?.TimeToLiveStatus;
    if ((status !== 'ENABLED' && status !== 'ENABLING') || !live?.AttributeName) {
      this.logger.debug(
        ids.maskSecrets(
          `TimeToLive already ${status ?? 'DISABLED'} on DynamoDB table ${tableName}; nothing to disable`
        )
      );
      return;
    }
    enabled = false;
    attributeName = live.AttributeName;
  } else {
    enabled = plan.kind === 'enable';
    attributeName = plan.attributeName;
  }
  try {
    await sendTtlWaitingOutRateLimit(
      () =>
        this.retryOnTransientControlPlane(
          () =>
            this.dynamoDBClient.send(
              new UpdateTimeToLiveCommand({
                TableName: tableName,
                TimeToLiveSpecification: { Enabled: enabled, AttributeName: attributeName },
              })
            ),
          `${enabled ? 'set' : 'disable'} TTL on ${tableName}`,
          undefined,
          { maskSecrets: ids.maskSecrets, stopAtDeadline: true }
        ),
      {
        what: ids.maskSecrets(`DynamoDB TimeToLive rate-limit wait on ${tableName}`),
        announce: () =>
          this.logger.info(
            ids.maskSecrets(
              `DynamoDB table ${ids.logicalId}: TimeToLive was changed recently, and AWS ` +
                `refuses another change until its rate-limit interval passes (up to about an ` +
                `hour). Retrying every minute, like CloudFormation, within the resource timeout.`
            )
          ),
      }
    );
  } catch (error) {
    // A disable whose goal already holds (an earlier attempt that landed
    // before a later step failed, or an out-of-band disable).
    if (!enabled && isTtlAlreadyDisabled(describeAwsFailure(error).detail)) {
      this.logger.debug(
        ids.maskSecrets(`TimeToLive already disabled on DynamoDB table ${tableName}`)
      );
      return;
    }
    if (isTtlRateLimited(describeAwsFailure(error).detail)) {
      throw new ProvisioningError(
        `DynamoDB table ${ids.logicalId}: AWS refused to ${enabled ? 'enable' : 'disable'} ` +
          `TimeToLive because it was already modified within DynamoDB's rate-limit interval, ` +
          `and kept refusing until the resource timeout ran out. Redeploy once the interval ` +
          `has passed (up to about an hour), or raise --resource-timeout.`,
        ids.resourceType,
        ids.logicalId,
        tableName,
        error instanceof Error ? error : undefined
      );
    }
    throw error;
  }
  this.logger.debug(
    ids.maskSecrets(
      `Set TimeToLive Enabled=${enabled} AttributeName=${attributeName} on DynamoDB table ${tableName}`
    )
  );
}

/**
 * Apply the table's `ResourcePolicy` via the separate `PutResourcePolicy` /
 * `DeleteResourcePolicy` APIs (used by `update()` — `create()` rides the
 * policy on CreateTable directly). On removal — when the template drops the
 * block but it was present before — the existing policy is deleted.
 */
export async function applyResourcePolicy(
  this: DynamoDBTableProvider,
  tableArn: string,
  spec: unknown,
  previousSpec?: unknown
): Promise<void> {
  const policyDoc = this.extractResourcePolicyDocument(spec);
  if (policyDoc !== undefined) {
    // Wrapped in the transient-control-plane retry like the Kinesis /
    // ContributorInsights post-ACTIVE ops: update() runs PITR -> TTL ->
    // ResourcePolicy, and a preceding UpdateContinuousBackups leaves the
    // table settling, so a back-to-back PutResourcePolicy can hit
    // ResourceInUseException / "being updated".
    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new PutResourcePolicyCommand({ ResourceArn: tableArn, Policy: policyDoc })
        ),
      `put ResourcePolicy on ${tableArn}`
    );
    this.logger.debug(`Put ResourcePolicy on DynamoDB table ${tableArn}`);
    return;
  }

  // Removed from the template: delete the existing policy. NotFound is
  // idempotent success (no policy to remove).
  if (previousSpec !== undefined && previousSpec !== null) {
    try {
      await this.retryOnTransientControlPlane(
        () => this.dynamoDBClient.send(new DeleteResourcePolicyCommand({ ResourceArn: tableArn })),
        `delete ResourcePolicy on ${tableArn}`
      );
      this.logger.debug(`Deleted ResourcePolicy on DynamoDB table ${tableArn}`);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }
}
