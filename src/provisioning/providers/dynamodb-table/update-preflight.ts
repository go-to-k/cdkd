import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { requireConfigString } from '../../config-shape.js';
import { streamMemberRefusals } from '../../dynamodb-stream-members.js';
import type { UpdateContext, SecretMasker } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { onDemandCeilingRefusal, zeroCapacityIndexRefusal } from './capacity.js';
import { deletionProtectionRefusal } from './indexes.js';
import { pointInTimeRecoveryRefusal, sseSpecificationRefusal } from './table-helpers.js';

/**
 * The template-path refusals `update()` runs before its first AWS call.
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export function refuseUnsendableUpdate(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  maskSecrets: SecretMasker
): { deletionProtectionChanged: boolean; sseChanged: boolean; sseRefusal: string | undefined } {
  // An unreadable `StreamSpecification.ResourcePolicy` / `.Tags` (issue
  // #3458) is REFUSED on the template path, and here — before any call —
  // so nothing is left half applied. The member is an access grant: a
  // warn-and-skip would deploy green while a policy the template meant to
  // narrow stays as broad as it was, record the new block as applied, and
  // never be looked at again (the read-back gate skips an unreadable
  // member). The two state-borne callers keep the warning, since neither
  // has a template-side remedy; `planStreamMemberOps` says what they do.
  if (
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true &&
    JSON.stringify(properties['StreamSpecification']) !==
      JSON.stringify(previousProperties['StreamSpecification'])
  ) {
    const [streamRefusal] = streamMemberRefusals(properties['StreamSpecification']);
    if (streamRefusal !== undefined) {
      throw new ProvisioningError(
        `${streamRefusal}. Nothing was applied to DynamoDB table ${logicalId}; fix the ` +
          `template value`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  // A per-index `ProvisionedThroughput` of `{0, 0}` is REFUSED on the
  // template path (issue #3728), here — before any call — for the reason
  // `create()` fails on the same value: DynamoDB's minimum is 1, so the
  // template can never take effect, and the remedy is one template edit.
  // `applyGsiUpdates` used to warn-SKIP it on every caller, which deployed
  // green while recording a capacity that was never sent. The two
  // state-borne callers keep that skip (`skipZeroCapacityIndexUpdate` says
  // why): neither hands a bag the user can edit from the template.
  if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
    const zeroCapacityRefusal = zeroCapacityIndexRefusal(
      properties,
      previousProperties,
      logicalId,
      maskSecrets
    );
    if (zeroCapacityRefusal !== undefined) {
      throw new ProvisioningError(zeroCapacityRefusal, resourceType, logicalId, physicalId);
    }
  }

  // A malformed DESIRED `BillingMode` is REFUSED on the template path
  // (issue #3740, the #3728 shape), here — before the `DescribeTable` and
  // the tag diff below — rather than at its read further down, which runs
  // after the tag diff has landed. The value is template-borne and
  // `BillingMode` is mutable in place, so the remedy is one template edit;
  // the read's warn-and-keep-the-previous-mode arm stays for the two
  // state-borne callers, whose bag the user cannot edit from the template.
  // Gated on the value having CHANGED from the recorded one: an unchanged
  // malformed value is not a pending operation (that arm keeps the mode it
  // compared against, so no flip goes out for it), the same gate the
  // `StreamSpecification` refusal above takes. Same read, key, fallback and
  // path as that arm, so the two cannot disagree on a value; an ABSENT
  // value (the documented reset to PROVISIONED) takes the fallback there,
  // so it needs no gate of its own.
  if (
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true &&
    JSON.stringify(properties['BillingMode']) !== JSON.stringify(previousProperties['BillingMode'])
  ) {
    try {
      requireConfigString(
        properties['BillingMode'],
        'PROVISIONED',
        'AWS::DynamoDB::Table BillingMode'
      );
    } catch (error) {
      throw new ProvisioningError(
        `AWS::DynamoDB::Table ${logicalId}: ${
          describeAwsFailure(error).detail
        }. Nothing was applied to the table; fix the template value`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  // A `PointInTimeRecoverySpecification.RecoveryPeriodInDays` spelling
  // CloudFormation rejects is REFUSED on the template path (issue #3255),
  // here — before any call — rather than dropped by
  // `applyPointInTimeRecovery`, whose call then SUCCEEDED at DynamoDB's
  // default period while state recorded the declared one: permanent
  // drift. Gated on the block having CHANGED, the applier's own gate, so
  // an unchanged value (nothing is sent for it) is not refused; the two
  // state-borne callers keep the applier's warn-and-drop.
  if (
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true &&
    JSON.stringify(properties['PointInTimeRecoverySpecification']) !==
      JSON.stringify(previousProperties['PointInTimeRecoverySpecification'])
  ) {
    const pitrRefusal = pointInTimeRecoveryRefusal(properties['PointInTimeRecoverySpecification']);
    if (pitrRefusal !== undefined) {
      throw new ProvisioningError(
        `AWS::DynamoDB::Table ${logicalId}: ${pitrRefusal}. Nothing was applied to the ` +
          `table; fix the template value`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  // An `OnDemandThroughput` ceiling member CloudFormation rejects (issue
  // #3286), table-level and per index, is REFUSED on the template path
  // here — before any call — rather than dropped by
  // `coerceOnDemandCeilingsForSend`, whose call then SUCCEEDED with the
  // member unapplied while state recorded it: permanent drift. Only a
  // PENDING send is checked (`onDemandCeilingRefusal` says which); the two
  // state-borne callers keep the send path's warn-and-drop.
  if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
    const ceilingRefusal = onDemandCeilingRefusal(properties, previousProperties, logicalId);
    if (ceilingRefusal !== undefined) {
      throw new ProvisioningError(
        `${ceilingRefusal}. Nothing was applied to the table; fix the template value`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  // go-to-k/cdkd#5354: a changed `DeletionProtectionEnabled` that is no
  // boolean is REFUSED on the template path, before any call, rather than
  // sent for AWS to reject after the tag diff and the billing call have
  // landed. The state-borne callers warn and skip it (below).
  const deletionProtectionChanged =
    JSON.stringify(properties['DeletionProtectionEnabled']) !==
    JSON.stringify(previousProperties['DeletionProtectionEnabled']);
  if (
    deletionProtectionChanged &&
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true
  ) {
    const protectionRefusal = deletionProtectionRefusal(
      properties['DeletionProtectionEnabled'],
      logicalId
    );
    if (protectionRefusal !== undefined) {
      throw new ProvisioningError(
        `${maskSecrets(protectionRefusal)}. Nothing was applied to the table; fix ` +
          `the template value`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  // go-to-k/cdkd#5412: a changed `SSESpecification.SSEEnabled` that is no
  // boolean is REFUSED on the template path, before any call: read as
  // `false` it would move the table to the AWS owned key. The state-borne
  // callers warn and skip it (below).
  const sseChanged =
    JSON.stringify(properties['SSESpecification']) !==
    JSON.stringify(previousProperties['SSESpecification']);
  const sseRefusal = sseChanged
    ? sseSpecificationRefusal(properties['SSESpecification'], logicalId)
    : undefined;
  if (
    sseRefusal !== undefined &&
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true
  ) {
    throw new ProvisioningError(
      `${maskSecrets(sseRefusal)}. Nothing was applied to the table; fix the template value`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  return { deletionProtectionChanged, sseChanged, sseRefusal };
}

/**
 * The per-index `OnDemandThroughput` refusal under an effective PROVISIONED mode.
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export function refuseIndexCeilingsUnderProvisioned(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context: UpdateContext | undefined,
  maskSecrets: SecretMasker,
  warn: (message: string) => void,
  billingOrThroughputChanged: boolean,
  effectiveBillingMode: 'PROVISIONED' | 'PAY_PER_REQUEST'
): void {
  if (effectiveBillingMode === 'PROVISIONED') {
    // TRUTHINESS, matching `indexCeilingForSend`'s own gate and the `Create`
    // arm's `gsi.OnDemandThroughput` test exactly. A refusal NARROWER than
    // the send leaves a hole; a WIDER one refuses a deploy that would have
    // been fine.
    const ceilingIndexNames = (
      Array.isArray(properties['GlobalSecondaryIndexes'])
        ? (properties['GlobalSecondaryIndexes'] as unknown[])
        : []
    )
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      )
      .filter((entry) => Boolean(entry['OnDemandThroughput']))
      // The index NAME is a RESOLVED property value, and the `IndexName!`
      // cast every other site in this file carries means a NUMERIC name
      // really does arrive — which is why this renders through the same
      // `<unnamed>` fallback {@link indexScopeAt} uses rather than handing
      // a non-string to the masker's `String.prototype.replace`.
      .map((entry) =>
        typeof entry['IndexName'] === 'string'
          ? maskSecrets(entry['IndexName'])
          : // The same literal {@link indexScopeAt} renders, so a user
            // grepping their log for one finds the other.
            '<unnamed>'
      );
    if (ceilingIndexNames.length > 0) {
      const modeNote = billingOrThroughputChanged
        ? ''
        : ' (the table is already PROVISIONED in AWS and this update sends no BillingMode change)';
      const message =
        `AWS::DynamoDB::Table ${logicalId}: GlobalSecondaryIndexes ` +
        `${ceilingIndexNames.join(', ')} declare OnDemandThroughput while the table's ` +
        `billing mode is PROVISIONED${modeNote}, which AWS accepts only on a ` +
        `PAY_PER_REQUEST table. Remove the per-index OnDemandThroughput, or set ` +
        `BillingMode: PAY_PER_REQUEST.`;
      // DOWNGRADE on a NON-TEMPLATE desired bag, unlike the table-level
      // twin — and the difference is not a style choice. That arm can state
      // that its shape "cannot occur in a valid record"; this one cannot.
      // Before issue #3287 NEITHER `Update` arm sent the member, so a
      // PROVISIONED table carrying a per-index ceiling DEPLOYED GREEN and
      // was recorded, and a hard throw would leave such a stack
      // un-rollbackable with no template-side remedy — the exact class
      // `.claude/rules/provider-replay-and-refusals.md` exists to prevent.
      //
      // BOTH flags, not just `replayingState` (the go-to-k/cdkd#3401 code
      // review, finding 3). That rule file says to ask per site what each of
      // the THREE `update()` callers means by the value, and here the answer
      // is the same for two of them: the rollback executor's revert arms set
      // `replayingState`, `cdkd drift --revert` sets
      // `desiredFromAwsReadback`, and NEITHER hands a bag the user can edit
      // from the template. Gating on `replayingState` alone left
      // `drift --revert` hard-throwing on exactly the legitimate record this
      // downgrade exists for, aborting the revert of every OTHER drifted
      // property on the same table. In the common case the arm emits no
      // ceiling op at all — the change detector compares the record against
      // itself — so the downgrade usually lets the operation SUCCEED rather
      // than merely deferring the failure to AWS. The deploy engine sets
      // neither flag, so the refusal stands on the template path.
      //
      // The flip side, stated rather than glossed: on the TEMPLATE path this
      // IS a behaviour change on the steady-state shape. A PROVISIONED table
      // whose template has always carried a per-index ceiling deployed green
      // whenever the ceiling was UNCHANGED (the change detector returns
      // before the send), and now fails at pre-flight. That is deliberate:
      // the ceiling can never take effect on such a table, the user believes
      // they have a cost cap and do not, and the remedy is one template edit.
      //
      // ASYMMETRY WITH THE TABLE-LEVEL TWIN, named because it is a decision
      // and not an oversight (the go-to-k/cdkd#3401 spec review, m1). This
      // arm refuses a population the arm above deliberately EXEMPTS: a
      // steady-state PROVISIONED table declaring a TABLE-level ceiling is
      // still forwarded, and `dynamodb-table-provider-billing-mode-removal
      // .test.ts`'s "leaves the pre-existing always-absent-BillingMode +
      // OnDemandThroughput shape alone" pins that as recorded judgment —
      // widening the table-level arm "would change behavior well outside
      // this issue". So the same property is refused at an INDEX and
      // forwarded at the TABLE of the same table. What breaks the tie here
      // is that the two positions differ in CONSEQUENCE, not in validity:
      // the table-level send is its own `UpdateTable` and fails alone,
      // while all THREE per-index sites ride one
      // `GlobalSecondaryIndexUpdates` array and take a co-resident capacity
      // edit down with them, AFTER the flip. Widening the table-level arm
      // to match is a separate behaviour change with its own review round.
      if (context?.replayingState === true || context?.desiredFromAwsReadback === true) {
        warn(
          `${message} Downgraded to a warning because this update's desired properties ` +
            `did not come from the template, so there is no template-side remedy; the ` +
            `per-index ceiling will be sent and AWS will reject it.`
        );
      } else {
        throw new ProvisioningError(
          `${message} No BillingMode flip and no index change were applied.`,
          resourceType,
          logicalId,
          physicalId
        );
      }
    }
  }
}
